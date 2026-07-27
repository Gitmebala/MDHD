/**
 * MDHD — signaling server for a 2-person, low-bandwidth WebRTC call.
 *
 * This server is ONLY a signaling relay + static file host. Audio and video never
 * touch it: once the two browsers have exchanged SDP and ICE candidates they talk
 * directly (P2P). That is the single biggest "data saving" decision in the whole
 * app -- a relayed (TURN) call would double the bytes and add latency.
 *
 * Rooms hold a maximum of 2 sockets. A third joiner is rejected outright.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PEERS_PER_ROOM = 2;

const app = express();
const server = http.createServer(app);

// Socket.IO tuning: long-ish ping interval so a phone that briefly sleeps the
// radio (screen lock, tunnel, lift ride) is not immediately declared dead.
// The signaling channel itself is tiny -- a few KB per call -- so these
// keepalives are irrelevant to the data budget.
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 30000,
});

// No max-age. The whole app is a few tens of KB, and ETag revalidation costs one
// tiny 304 per file per load. A cache lifetime here would mean that pushing a
// fix leaves both phones running stale JS until it expires — not worth it for
// bytes this small.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    if (/\.(html|js|css|json)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');   // revalidate, don't re-download
    }
  },
}));

// Health check for Render/Railway.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

/**
 * Serve the app shell explicitly at "/".
 *
 * Do not rely on express.static's implicit directory-index lookup: in
 * production on Render it served /index.html and /style.css correctly but
 * returned 404 for "/", while the same code served "/" fine locally. Being
 * explicit costs one route and removes a whole class of environment-dependent
 * behaviour.
 */
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * roomName -> Set<socketId>
 * Socket.IO already tracks rooms internally, but keeping our own map makes the
 * "max 2" check explicit and easy to reason about.
 */
const rooms = new Map();

function peersIn(room) {
  return rooms.get(room) || new Set();
}

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join', (rawRoom) => {
    const room = String(rawRoom || '').trim().slice(0, 64);
    if (!room) {
      socket.emit('join-error', { reason: 'invalid-room' });
      return;
    }
    if (joinedRoom) {
      socket.emit('join-error', { reason: 'already-joined' });
      return;
    }

    const existing = peersIn(room);
    if (existing.size >= MAX_PEERS_PER_ROOM) {
      socket.emit('room-full', { room, max: MAX_PEERS_PER_ROOM });
      console.log(`[room:${room}] rejected ${socket.id} (full)`);
      return;
    }

    // The FIRST peer in the room becomes the "impolite" peer in the perfect-
    // negotiation dance (see public/app.js). The second is "polite" and yields
    // on offer collisions. Deciding this here, once, avoids a whole class of
    // glare bugs and makes ICE restarts deterministic.
    const isFirst = existing.size === 0;

    existing.add(socket.id);
    rooms.set(room, existing);
    socket.join(room);
    joinedRoom = room;

    socket.emit('joined', {
      room,
      polite: !isFirst,          // second joiner is polite
      peerPresent: !isFirst,     // is someone already here to call?
      peerCount: existing.size,
    });

    // Tell the peer who was already waiting that their partner arrived.
    socket.to(room).emit('peer-joined', { peerCount: existing.size });

    console.log(`[room:${room}] ${socket.id} joined (${existing.size}/${MAX_PEERS_PER_ROOM}, polite=${!isFirst})`);
  });

  /**
   * Opaque signaling relay. We deliberately do not inspect or rewrite SDP here --
   * all codec preference and bitrate munging happens in the browser, where the
   * actual capabilities live.
   */
  socket.on('signal', (payload) => {
    if (!joinedRoom) return;
    socket.to(joinedRoom).emit('signal', payload);
  });

  // Lightweight text chat / status pings over the signaling channel (optional,
  // costs a few hundred bytes).
  socket.on('peer-state', (payload) => {
    if (!joinedRoom) return;
    socket.to(joinedRoom).emit('peer-state', payload);
  });

  socket.on('disconnect', (reason) => {
    if (!joinedRoom) return;
    const set = peersIn(joinedRoom);
    set.delete(socket.id);
    if (set.size === 0) rooms.delete(joinedRoom);
    socket.to(joinedRoom).emit('peer-left', { reason });
    console.log(`[room:${joinedRoom}] ${socket.id} left (${reason}) -> ${set.size} remaining`);
    joinedRoom = null;
  });
});

server.listen(PORT, () => {
  console.log(`MDHD signaling server listening on http://localhost:${PORT}`);
  console.log('Open  http://localhost:3000/?room=ourroom  in two tabs to test.');
});
