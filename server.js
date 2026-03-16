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

// ─── iTunes Search API (gratuit, sans auth, previews garantis) ────────────────

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
  for (const d of ALL_DECADES) {
    if (targetYear >= d) best = d;
    else break;
  }
  const artists = FRENCH_ARTISTS_BY_DECADE[best];
  return artists[Math.floor(Math.random() * artists.length)];
}

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildCard(track, fallbackYear) {
  const year = track.releaseDate ? parseInt(track.releaseDate.substring(0, 4)) : fallbackYear;
  const cover = track.artworkUrl100
    ? track.artworkUrl100.replace('100x100bb', '300x300bb').replace('100x100', '300x300')
    : null;
  return {
    id:          `${Date.now()}`,
    year:        isNaN(year) ? fallbackYear : year,
    title:       track.trackName ?? null,
    artist:      track.artistName ?? null,
    previewUrl:  track.previewUrl ?? null,
    albumCover:  cover,
    spotifyUri:  null,
    spotifyUrl:  track.trackViewUrl ?? null,  // lien Apple Music
  };
}

async function fetchCard(targetYear) {
  const year   = targetYear || (1950 + Math.floor(Math.random() * 77));
  const artist = pickArtistForYear(year);

  try {
    const url  = `https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&country=FR&media=music&entity=song&limit=50`;
    const res  = await fetch(url);
    const data = await res.json();
    const tracks = (data.results ?? []).filter(t => t.previewUrl && t.trackName);

    if (tracks.length > 0) {
      console.log(`🎵 iTunes: ${artist} → ${tracks.length} titres`);
      return buildCard(rand(tracks), year);
    }
  } catch (e) {
    console.error('iTunes search error:', e.message);
  }

  // Fallback artiste populaire garanti
  try {
    const fallback = rand(['Stromae', 'Aya Nakamura', 'Francis Cabrel', 'Jean-Jacques Goldman',
      'Edith Piaf', 'Mylène Farmer', 'Patrick Bruel', 'Serge Gainsbourg',
      'Vanessa Paradis', 'Michel Sardou', 'Dalida', 'Johnny Hallyday']);
    const url2  = `https://itunes.apple.com/search?term=${encodeURIComponent(fallback)}&country=FR&media=music&entity=song&limit=25`;
    const res2  = await fetch(url2);
    const data2 = await res2.json();
    const tracks2 = (data2.results ?? []).filter(t => t.previewUrl && t.trackName);
    if (tracks2.length > 0) return buildCard(rand(tracks2), year);
  } catch (e) {
    console.error('iTunes fallback error:', e.message);
  }

  return { id: `${Date.now()}`, year, title: null, artist: null, previewUrl: null, albumCover: null, spotifyUri: null, spotifyUrl: null };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));

app.get('/api/card', async (req, res) => {
  const year = req.query.year ? parseInt(req.query.year) : undefined;
  try {
    const card = await fetchCard(year);
    res.json(card);
  } catch (e) {
    console.error('/api/card error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Rooms ────────────────────────────────────────────────────────────────────

const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('+ Connected:', socket.id);

  socket.on('create-room', ({ playerName }, cb) => {
    let code = generateCode();
    while (rooms.has(code)) code = generateCode();
    const room = {
      code,
      hostId:           socket.id,
      players:          [{ id: socket.id, name: playerName || 'Hôte', cards: 0, tokens: 2, isHost: true }],
      gameStarted:      false,
      currentCard:      null,
      targetCards:      10,
      winnerId:         null,
      currentGuesserIdx: 0,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb({ success: true, code, room });
    console.log(`Room ${code} créée`);
  });

  socket.on('join-room', ({ code, playerName }, cb) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room)            return cb({ success: false, error: 'Salle introuvable.' });
    if (room.gameStarted) return cb({ success: false, error: 'Partie déjà commencée.' });
    if (room.players.find(p => p.id === socket.id)) return cb({ success: true, code, room });

    room.players.push({ id: socket.id, name: playerName || `Joueur ${room.players.length + 1}`, cards: 0, tokens: 2, isHost: false });
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    io.to(code.toUpperCase()).emit('room-updated', room);
    cb({ success: true, code: code.toUpperCase(), room });
    console.log(`${playerName} a rejoint la salle ${code}`);
  });

  socket.on('start-game', async ({ code, targetCards }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    room.gameStarted = true;
    room.targetCards = targetCards || 10;

    // Tire une carte initiale par joueur, remet les jetons à 2
    const initialCards = [];
    let lowestYear = Infinity;
    let lowestYearIdx = 0;
    for (let i = 0; i < room.players.length; i++) {
      room.players[i].tokens = 2;
      const card = await fetchCard();
      initialCards.push({ playerId: room.players[i].id, card });
      if ((card.year ?? 9999) < lowestYear) {
        lowestYear = card.year ?? 9999;
        lowestYearIdx = i;
      }
    }
    room.currentGuesserIdx = lowestYearIdx;

    io.to(code).emit('game-started', room);
    io.to(code).emit('initial-cards', {
      cards: initialCards,
      firstGuesserId: room.players[lowestYearIdx]?.id ?? null,
    });
    console.log(`Partie démarrée — Premier devinant: ${room.players[lowestYearIdx]?.name} (${lowestYear})`);
  });

  socket.on('draw-card', async ({ code, year }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    const card = await fetchCard(year);
    room.currentCard = card;
    const guesserIdx = room.currentGuesserIdx % room.players.length;
    const guesser = room.players[guesserIdx];
    io.to(code).emit('card-drawn', { card, guesserId: guesser?.id ?? null });
    console.log(`Carte: ${card.year} — ${card.title} (${card.artist}) | Devinant: ${guesser?.name}`);
  });

  socket.on('next-turn', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    room.currentGuesserIdx = (room.currentGuesserIdx + 1) % room.players.length;
    room.currentCard = null;
    const guesser = room.players[room.currentGuesserIdx];
    io.to(code).emit('turn-changed', { guesserId: guesser?.id ?? null });
    console.log(`Tour suivant — Devinant: ${guesser?.name}`);
  });

  socket.on('update-score', ({ code, playerId, cardDelta, tokenDelta }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    if (typeof cardDelta  === 'number') player.cards  = Math.max(0, player.cards  + cardDelta);
    if (typeof tokenDelta === 'number') player.tokens = Math.max(0, player.tokens + tokenDelta);
    if (player.cards >= room.targetCards) room.winnerId = player.id;
    io.to(code).emit('scores-updated', { players: room.players, winnerId: room.winnerId });
  });

  socket.on('reset-scores', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    room.players.forEach(p => { p.cards = 0; p.tokens = 2; });
    room.winnerId         = null;
    room.currentCard      = null;
    room.currentGuesserIdx = 0;
    const guesser = room.players[0];
    io.to(code).emit('scores-updated', { players: room.players, winnerId: null });
    io.to(code).emit('card-drawn', { card: null, guesserId: guesser?.id ?? null });
  });

  socket.on('disconnect', () => {
    const code = socket.data?.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      room.players.splice(idx, 1);
      if (room.players.length === 0) {
        rooms.delete(code);
      } else {
        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
          room.players[0].isHost = true;
        }
        io.to(code).emit('room-updated', room);
      }
    }
    console.log('- Déconnecté:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`🎮 Hister backend démarré sur le port ${PORT}`));
