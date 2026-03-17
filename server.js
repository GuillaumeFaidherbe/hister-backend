const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ─── iTunes Search API ────────────────────────────────────────────────────────

const FRENCH_ARTISTS_BY_DECADE = {
  1950: ['Edith Piaf', 'Yves Montand', 'Charles Trenet', 'Henri Salvador', 'Juliette Gréco', 'Charles Aznavour', 'Gilbert Bécaud', 'Léo Ferré'],
  1960: ['Jacques Brel', 'Serge Gainsbourg', 'Françoise Hardy', 'Dalida', 'Claude François', 'Antoine', 'Sacha Distel', 'Michel Polnareff', 'Sylvie Vartan', 'Johnny Hallyday', 'Adamo'],
  1970: ['Joe Dassin', 'Michel Sardou', 'Julien Clerc', 'Alain Souchon', 'Véronique Sanson', 'Gérard Lenorman', 'Carlos', 'Michel Delpech', 'Daniel Guichard'],
  1980: ['Jean-Jacques Goldman', 'Francis Cabrel', 'Renaud', 'Patricia Kaas', 'Mylène Farmer', 'Indochine', 'Téléphone', 'Étienne Daho', 'Vanessa Paradis', 'Herbert Léonard'],
  1990: ['Céline Dion', 'Lara Fabian', 'Patrick Bruel', 'MC Solaar', 'IAM', 'NTM', 'Zazie', 'Pascal Obispo', 'M Pokora', 'Calogero'],
  2000: ['Christophe Maé', 'Corneille', 'Amel Bent', 'Raphael', 'Gaëtan Roussel', 'Kyo', 'Dionysos', 'Olivia Ruiz'],
  2010: ['Stromae', 'Maître Gims', 'Black M', 'Soprano', 'Kendji Girac', 'Louane', 'Vianney', 'Slimane', 'Julien Doré', 'Zaz', 'Lomepal', 'Orelsan'],
  2020: ['Aya Nakamura', 'Ninho', 'Tayc', 'Soolking', 'Naps', 'Hatik', 'Gims', 'Pomme', 'Angèle', 'Lous and The Yakuza'],
};

const ALL_DECADES = Object.keys(FRENCH_ARTISTS_BY_DECADE).map(Number).sort((a, b) => a - b);

function pickArtistForYear(targetYear) {
  let best = ALL_DECADES[0];
  for (const d of ALL_DECADES) { if (targetYear >= d) best = d; else break; }
  const artists = FRENCH_ARTISTS_BY_DECADE[best];
  return artists[Math.floor(Math.random() * artists.length)];
}

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildCard(track, fallbackYear) {
  const year  = track.releaseDate ? parseInt(track.releaseDate.substring(0, 4)) : fallbackYear;
  const cover = track.artworkUrl100
    ? track.artworkUrl100.replace('100x100bb', '300x300bb').replace('100x100', '300x300')
    : null;
  return {
    id:         `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    year:       isNaN(year) ? fallbackYear : year,
    title:      track.trackName  ?? null,
    artist:     track.artistName ?? null,
    previewUrl: track.previewUrl ?? null,
    albumCover: cover,
    spotifyUri: null,
    spotifyUrl: track.trackViewUrl ?? null,
  };
}

async function fetchCard(targetYear) {
  const year   = targetYear || (1950 + Math.floor(Math.random() * 77));
  const artist = pickArtistForYear(year);
  try {
    const url    = `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&country=FR&media=music&entity=song&limit=50&lang=fr_fr`;
    const res    = await fetch(url);
    const data   = await res.json();
    const tracks = (data.results ?? []).filter(t =>
      t.previewUrl && t.trackName &&
      t.artistName?.toLowerCase().includes(artist.split(' ')[0].toLowerCase())
    );
    if (tracks.length > 0) { console.log(`🎵 ${artist} → ${tracks.length} titres`); return buildCard(rand(tracks), year); }
  } catch (e) { console.error('iTunes error:', e.message); }

  try {
    const fb     = rand(['Stromae','Aya Nakamura','Francis Cabrel','Jean-Jacques Goldman','Edith Piaf','Mylène Farmer','Patrick Bruel','Serge Gainsbourg','Vanessa Paradis','Michel Sardou','Dalida','Johnny Hallyday']);
    const res2   = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(fb)}&country=FR&media=music&entity=song&limit=25`);
    const data2  = await res2.json();
    const tracks2 = (data2.results ?? []).filter(t => t.previewUrl && t.trackName);
    if (tracks2.length > 0) return buildCard(rand(tracks2), year);
  } catch (e) { console.error('iTunes fallback error:', e.message); }

  return { id: `${Date.now()}`, year, title: null, artist: null, previewUrl: null, albumCover: null, spotifyUri: null, spotifyUrl: null };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));
app.get('/api/card', async (req, res) => {
  try { res.json(await fetchCard(req.query.year ? parseInt(req.query.year) : undefined)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Rooms ────────────────────────────────────────────────────────────────────

const rooms            = new Map();
const disconnectTimers = new Map(); // `${playerName}${code}` → timer

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function touch(room) { room.lastActivity = Date.now(); }

// ─── TTL : purge les salles inactives depuis > 2h ─────────────────────────────
const TWO_HOURS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - (room.lastActivity ?? 0) > TWO_HOURS) {
      io.to(code).emit('room-expired');
      rooms.delete(code);
      console.log(`Room ${code} expirée`);
    }
  }
}, 10 * 60 * 1000);

const ALLOWED_REACTIONS = ['🎉', '👏', '😱', '🔥', '😂'];

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('+ Connected:', socket.id);

  // ── Helper : distribue les cartes de départ ────────────────────────────────
  async function dealInitialCards(room) {
    const code = room.code;
    const initialCards = [];
    let lowestYear = Infinity, lowestYearIdx = 0;

    for (let i = 0; i < room.players.length; i++) {
      room.players[i].tokens   = 2;
      room.players[i].cards    = 1;
      room.players[i].timeline = [];
      const card = await fetchCard();
      room.players[i].timeline.push(card);
      initialCards.push({ playerId: room.players[i].id, card });
      if ((card.year ?? 9999) < lowestYear) { lowestYear = card.year ?? 9999; lowestYearIdx = i; }
    }

    room.currentGuesserIdx = lowestYearIdx;
    room.winnerId          = null;
    room.currentCard       = null;
    room.cardPlaced        = false;
    room.placedPosition    = null;
    room.pendingCorrect    = null;
    room.histerVotes       = [];
    room.histerMajority    = false;
    room.history           = [];
    touch(room);

    fetchCard().then(c => { room.nextCard = c; }).catch(() => {});

    io.to(code).emit('room-updated', room);
    io.to(code).emit('initial-cards', {
      cards: initialCards,
      firstGuesserId: room.players[lowestYearIdx]?.id ?? null,
    });
    console.log(`Cartes distribuées — Premier devinant: ${room.players[lowestYearIdx]?.name} (${lowestYear})`);
  }

  // ── Créer une salle ────────────────────────────────────────────────────────
  socket.on('create-room', ({ playerName }, cb) => {
    let code = generateCode();
    while (rooms.has(code)) code = generateCode();
    const room = {
      code, hostId: socket.id,
      players: [{ id: socket.id, name: playerName || 'Hôte', cards: 0, tokens: 2, isHost: true, isOnline: true, timeline: [] }],
      gameStarted: false, currentCard: null, nextCard: null,
      targetCards: 10, winnerId: null,
      currentGuesserIdx: 0, cardPlaced: false, placedPosition: null,
      pendingCorrect: null, histerVotes: [], histerMajority: false,
      history: [], lastActivity: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode   = code;
    socket.data.playerName = playerName || 'Hôte';
    cb({ success: true, code, room });
    console.log(`Room ${code} créée par ${playerName}`);
  });

  // ── Rejoindre une salle ────────────────────────────────────────────────────
  socket.on('join-room', ({ code, playerName }, cb) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room)            return cb({ success: false, error: 'Salle introuvable.' });
    if (room.gameStarted) return cb({ success: false, error: 'Partie déjà commencée.' });
    if (room.players.find(p => p.id === socket.id)) return cb({ success: true, code, room });

    room.players.push({ id: socket.id, name: playerName || `Joueur ${room.players.length + 1}`, cards: 0, tokens: 2, isHost: false, isOnline: true, timeline: [] });
    socket.join(code.toUpperCase());
    socket.data.roomCode   = code.toUpperCase();
    socket.data.playerName = playerName;
    touch(room);
    io.to(code.toUpperCase()).emit('room-updated', room);
    cb({ success: true, code: code.toUpperCase(), room });
    console.log(`${playerName} a rejoint ${code}`);
  });

  // ── Reconnexion après coupure réseau ──────────────────────────────────────
  socket.on('rejoin-room', ({ code, playerName }, cb) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return cb({ success: false, error: 'Salle introuvable.' });

    const timerKey = `${playerName}${code.toUpperCase()}`;
    const timer    = disconnectTimers.get(timerKey);
    if (timer) { clearTimeout(timer); disconnectTimers.delete(timerKey); }

    const player = room.players.find(p => p.name === playerName);
    if (!player) return cb({ success: false, error: 'Joueur introuvable.' });

    player.id       = socket.id;
    player.isOnline = true;
    if (room.hostId === player.id || !room.players.find(p => p.isHost && p.id !== socket.id)) {
      room.hostId      = socket.id;
      player.isHost    = true;
    }
    socket.join(code.toUpperCase());
    socket.data.roomCode   = code.toUpperCase();
    socket.data.playerName = playerName;
    touch(room);

    io.to(code.toUpperCase()).emit('room-updated', room);
    cb({
      success:        true,
      room,
      currentCard:    room.currentCard,
      guesserId:      room.players[room.currentGuesserIdx % room.players.length]?.id ?? null,
      cardPlaced:     room.cardPlaced,
      placedPosition: room.placedPosition,
      histerVotes:    room.histerVotes,
      histerMajority: room.histerMajority,
    });
    console.log(`${playerName} reconnecté à ${code}`);
  });

  // ── Lancer la partie ───────────────────────────────────────────────────────
  socket.on('start-game', async ({ code, targetCards }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    room.gameStarted = true;
    room.targetCards = targetCards || 10;
    touch(room);
    io.to(code).emit('game-started', room);
    await dealInitialCards(room);
  });

  // ── Tirer une carte (utilise la carte pré-chargée si dispo) ───────────────
  socket.on('draw-card', async ({ code, year }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;

    const card = room.nextCard ?? await fetchCard(year);
    room.nextCard    = null;
    room.currentCard = card;
    touch(room);

    const guesser = room.players[room.currentGuesserIdx % room.players.length];
    io.to(code).emit('card-drawn', { card, guesserId: guesser?.id ?? null });

    fetchCard().then(c => { room.nextCard = c; }).catch(() => {});
    console.log(`Carte: ${card.year} — ${card.title} | Devinant: ${guesser?.name}`);
  });

  // ── Placement de la carte ──────────────────────────────────────────────────
  socket.on('place-card', ({ code, position }) => {
    const room = rooms.get(code);
    if (!room) return;
    const guesser = room.players[room.currentGuesserIdx % room.players.length];
    if (socket.id !== guesser?.id) return;

    const timeline  = guesser.timeline;
    const card      = room.currentCard;
    const year      = card?.year ?? 0;
    const before    = timeline[position - 1];
    const after     = timeline[position];
    const isCorrect = (!before || year >= before.year) && (!after || year <= after.year);

    room.cardPlaced     = true;
    room.placedPosition = position;
    room.pendingCorrect = isCorrect;
    room.histerVotes    = [];
    room.histerMajority = false;
    touch(room);

    io.to(code).emit('card-placed', { guesserId: guesser.id, position });
    console.log(`${guesser.name} place sa carte — ${isCorrect ? '✅' : '❌'}`);
  });

  // ── Vote Hister (plusieurs joueurs peuvent voter) ──────────────────────────
  socket.on('call-hister', ({ code }) => {
    const room = rooms.get(code);
    if (!room || !room.cardPlaced) return;
    const guesser = room.players[room.currentGuesserIdx % room.players.length];
    if (socket.id === guesser?.id) return;
    if (room.histerVotes.includes(socket.id)) return;

    room.histerVotes.push(socket.id);
    touch(room);

    const nonGuessers = room.players.filter(p => p.id !== guesser?.id);
    const votes       = room.histerVotes.length;
    const total       = nonGuessers.length;
    const majority    = votes > total / 2;
    const voterNames  = room.histerVotes.map(id => room.players.find(p => p.id === id)?.name ?? '?');

    io.to(code).emit('hister-vote-update', { votes, total, voterIds: room.histerVotes, voterNames });

    if (majority && !room.histerMajority) {
      room.histerMajority = true;
      io.to(code).emit('hister-majority', { voterIds: room.histerVotes, voterNames });
    }
    console.log(`HISTER ! ${votes}/${total} dans ${code}`);
  });

  // ── Révélation de l'année ──────────────────────────────────────────────────
  socket.on('reveal-result', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    const guesserIdx = room.currentGuesserIdx % room.players.length;
    const guesser    = room.players[guesserIdx];
    if (socket.id !== guesser?.id) return;

    const correct        = room.pendingCorrect ?? false;
    const card           = room.currentCard;
    const histerWinnerId = room.histerVotes[0] ?? null;
    const histerCaller   = histerWinnerId ? room.players.find(p => p.id === histerWinnerId) : null;
    touch(room);

    if (correct) {
      guesser.cards += 1;
      if (card) { guesser.timeline.push(card); guesser.timeline.sort((a, b) => a.year - b.year); }
      if (histerCaller) histerCaller.tokens = Math.max(0, histerCaller.tokens - 1);
    } else {
      if (histerCaller && card) {
        histerCaller.cards += 1;
        histerCaller.timeline.push(card);
        histerCaller.timeline.sort((a, b) => a.year - b.year);
      }
    }

    if (guesser.cards >= room.targetCards)                         room.winnerId = guesser.id;
    if (histerCaller && histerCaller.cards >= room.targetCards)    room.winnerId = histerCaller.id;

    room.history.push({
      turnNumber: room.history.length + 1,
      guesserId: guesser.id, guesserName: guesser.name,
      card, correct,
      histerMajority: room.histerMajority,
      histerVoterIds: [...room.histerVotes],
      histerCallerName: histerCaller?.name ?? null,
    });

    io.to(code).emit('turn-resolved', {
      correct,
      players:          room.players,
      winnerId:         room.winnerId,
      guesserId:        guesser.id,
      histerCallerId:   histerWinnerId,
      histerCallerName: histerCaller?.name ?? null,
      histerVoterIds:   room.histerVotes,
      histerMajority:   room.histerMajority,
      history:          room.history,
    });
    console.log(`Révélation — ${correct ? '✅' : '❌'}${histerCaller ? ` | Hister par ${histerCaller.name}` : ''}`);
  });

  // ── Tour suivant ───────────────────────────────────────────────────────────
  socket.on('next-turn', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    room.currentGuesserIdx = (room.currentGuesserIdx + 1) % room.players.length;
    room.currentCard = null; room.cardPlaced = false; room.placedPosition = null;
    room.pendingCorrect = null; room.histerVotes = []; room.histerMajority = false;
    touch(room);
    const guesser = room.players[room.currentGuesserIdx];
    io.to(code).emit('turn-changed', { guesserId: guesser?.id ?? null });
    console.log(`Tour suivant — Devinant: ${guesser?.name}`);
  });

  // ── Modification manuelle de score (hôte) ─────────────────────────────────
  socket.on('update-score', ({ code, playerId, cardDelta, tokenDelta }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    if (typeof cardDelta  === 'number') player.cards  = Math.max(0, player.cards  + cardDelta);
    if (typeof tokenDelta === 'number') player.tokens = Math.max(0, player.tokens + tokenDelta);
    if (player.cards >= room.targetCards) room.winnerId = player.id;
    touch(room);
    io.to(code).emit('scores-updated', { players: room.players, winnerId: room.winnerId });
  });

  // ── Rejouer ────────────────────────────────────────────────────────────────
  socket.on('reset-scores', async ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    touch(room);
    io.to(code).emit('game-started', room);
    await dealInitialCards(room);
    console.log(`Partie relancée dans ${code}`);
  });

  // ── Réactions emoji ────────────────────────────────────────────────────────
  socket.on('send-reaction', ({ code, emoji }) => {
    const room = rooms.get(code);
    if (!room || !ALLOWED_REACTIONS.includes(emoji)) return;
    const player = room.players.find(p => p.id === socket.id);
    io.to(code).emit('reaction', {
      id:         `${socket.id}-${Date.now()}`,
      playerId:   socket.id,
      playerName: player?.name ?? '?',
      emoji,
    });
  });

  // ── Déconnexion (avec grace period de 30s pour reconnexion) ───────────────
  socket.on('disconnect', () => {
    const code = socket.data?.roomCode;
    if (!code) { console.log('- Déconnecté (sans salle):', socket.id); return; }
    const room = rooms.get(code);
    if (!room) return;

    const player     = room.players.find(p => p.id === socket.id);
    const wasGuesser = room.gameStarted &&
      room.players[room.currentGuesserIdx % room.players.length]?.id === socket.id;

    if (!player) return;

    player.isOnline = false;
    io.to(code).emit('room-updated', room);

    const timerKey = `${player.name}${code}`;
    const timer = setTimeout(() => {
      disconnectTimers.delete(timerKey);
      const idx = room.players.findIndex(p => p.name === player.name && !p.isOnline);
      if (idx === -1) return;

      room.players.splice(idx, 1);
      if (room.players.length === 0) { rooms.delete(code); return; }

      if (room.hostId === socket.id) {
        room.hostId              = room.players[0].id;
        room.players[0].isHost  = true;
      }
      if (room.gameStarted && wasGuesser) {
        room.currentGuesserIdx = room.currentGuesserIdx % room.players.length;
        room.currentCard = null; room.cardPlaced = false; room.placedPosition = null;
        room.pendingCorrect = null; room.histerVotes = []; room.histerMajority = false;
        const next = room.players[room.currentGuesserIdx];
        io.to(code).emit('turn-changed', { guesserId: next?.id ?? null, reason: 'disconnected' });
      }
      io.to(code).emit('room-updated', room);
    }, 30_000);

    disconnectTimers.set(timerKey, timer);
    console.log(`- Déconnecté (grace 30s): ${player.name} / ${code}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`🎮 Hister backend port ${PORT}`));
