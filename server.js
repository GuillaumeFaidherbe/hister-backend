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

// ─── Spotify ──────────────────────────────────────────────────────────────────

const SPOTIFY_CLIENT_ID     = '37437f33822e41bbbccdfcd1dd14807f';
const SPOTIFY_CLIENT_SECRET = 'acf141ff19c14362ba5f938380628239';

let spotifyToken = null;
let tokenExpiry  = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Spotify token error: ' + JSON.stringify(data));
  spotifyToken = data.access_token;
  tokenExpiry  = Date.now() + (data.expires_in - 60) * 1000;
  console.log('🎵 Spotify token rafraîchi');
  return spotifyToken;
}

// ─── Artistes français par décennie ──────────────────────────────────────────

const FRENCH_ARTISTS_BY_DECADE = {
  1950: ['Edith Piaf', 'Yves Montand', 'Charles Trenet', 'Henri Salvador', 'Juliette Gréco', 'Charles Aznavour', 'Gilbert Bécaud', 'Léo Ferré'],
  1960: ['Jacques Brel', 'Serge Gainsbourg', 'Françoise Hardy', 'Dalida', 'Claude François', 'Antoine', 'Sacha Distel', 'Michel Polnareff', 'Sylvie Vartan', 'Johnny Hallyday', 'Adamo'],
  1970: ['Joe Dassin', 'Michel Sardou', 'Julien Clerc', 'Alain Souchon', 'Véronique Sanson', 'Gérard Lenorman', 'Claude François', 'Carlos', 'Michel Delpech', 'Daniel Guichard'],
  1980: ['Jean-Jacques Goldman', 'Francis Cabrel', 'Renaud', 'Patricia Kaas', 'Mylène Farmer', 'Indochine', 'Téléphone', 'Étienne Daho', 'Goldman', 'Alain Barrière', 'Herbert Léonard'],
  1990: ['Céline Dion', 'Lara Fabian', 'Vanessa Paradis', 'Patrick Bruel', 'MC Solaar', 'IAM', 'NTM', 'Akhénaton', 'Zazie', 'Pascal Obispo', 'Grégory Lemarchal', 'M Pokora'],
  2000: ['Christophe Maé', 'Corneille', 'Amel Bent', 'Kamel', 'Raphael', 'Tété', 'Gaëtan Roussel', 'Calogero', 'Kyo', 'Dionysos', 'Les Wampas', 'Olivia Ruiz'],
  2010: ['Stromae', 'Maître Gims', 'Black M', 'Soprano', 'Kendji Girac', 'Louane', 'Vianney', 'Slimane', 'Julien Doré', 'Christophe Willem', 'Carla Bruni', 'Camille', 'Zaz'],
  2020: ['Aya Nakamura', 'Ninho', 'Tayc', 'Soolking', 'Naps', 'Hatik', 'Gims', 'Slimane', 'Lous and The Yakuza', 'Pomme', 'Angèle', 'Lomepal', 'Orelsan'],
};

const ALL_DECADES = Object.keys(FRENCH_ARTISTS_BY_DECADE).map(Number).sort((a, b) => a - b);

function pickArtistForYear(targetYear) {
  // Trouve la décennie la plus proche
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

async function fetchCard(targetYear) {
  const year = targetYear || (1950 + Math.floor(Math.random() * 77)); // 1950–2026
  const token = await getSpotifyToken();

  const artist = pickArtistForYear(year);
  try {
    const q = encodeURIComponent(artist);
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${q}&type=track&market=FR&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();

    // Filtrer : lien Spotify présent + pas de compilation (années souvent fausses)
    const tracks = (data.tracks?.items ?? []).filter(t =>
      t.external_urls?.spotify &&
      t.album?.album_type !== 'compilation'
    );

    if (tracks.length > 0) {
      const t = rand(tracks);
      const actualYear = parseInt(t.album?.release_date?.substring(0, 4)) || year;
      return buildCard(t, actualYear);
    }
  } catch (e) {
    console.error('Spotify artist search error:', e.message);
  }

  // Fallback avec artiste populaire garanti
  try {
    const fallback = rand(['Stromae', 'Aya Nakamura', 'Francis Cabrel', 'Jean-Jacques Goldman',
      'Edith Piaf', 'Serge Gainsbourg', 'Mylène Farmer', 'Patrick Bruel',
      'Vanessa Paradis', 'Michel Sardou', 'Dalida', 'Johnny Hallyday']);
    const q2 = encodeURIComponent(fallback);
    const res2 = await fetch(
      `https://api.spotify.com/v1/search?q=${q2}&type=track&market=FR&limit=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data2 = await res2.json();
    const tracks2 = (data2.tracks?.items ?? []).filter(t =>
      t.external_urls?.spotify && t.album?.album_type !== 'compilation'
    );
    if (tracks2.length > 0) {
      const t = rand(tracks2);
      const actualYear = parseInt(t.album?.release_date?.substring(0, 4)) || year;
      return buildCard(t, actualYear);
    }
  } catch (e) {
    console.error('Spotify fallback error:', e.message);
  }

  return { id: `${Date.now()}`, year, title: null, artist: null, previewUrl: null, albumCover: null, spotifyUri: null, spotifyUrl: null };
}

function buildCard(track, year) {
  return {
    id:          `${Date.now()}`,
    year,
    title:       track.name,
    artist:      track.artists.map(a => a.name).join(', '),
    previewUrl:  track.preview_url ?? null,        // null pour les nouvelles apps Spotify
    albumCover:  track.album?.images?.[1]?.url ?? track.album?.images?.[0]?.url ?? null,
    spotifyUri:  track.uri ?? null,                // ex: spotify:track:XXXXXX
    spotifyUrl:  track.external_urls?.spotify ?? null, // ex: https://open.spotify.com/track/XXXXX
  };
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
      players:          [{ id: socket.id, name: playerName || 'Hôte', cards: 0, tokens: 0, isHost: true }],
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

    room.players.push({ id: socket.id, name: playerName || `Joueur ${room.players.length + 1}`, cards: 0, tokens: 0, isHost: false });
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    io.to(code.toUpperCase()).emit('room-updated', room);
    cb({ success: true, code: code.toUpperCase(), room });
    console.log(`${playerName} a rejoint la salle ${code}`);
  });

  socket.on('start-game', ({ code, targetCards }) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    room.gameStarted = true;
    room.targetCards = targetCards || 10;
    io.to(code).emit('game-started', room);
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
    room.players.forEach(p => { p.cards = 0; p.tokens = 0; });
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
