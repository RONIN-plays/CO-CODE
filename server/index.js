// CoCode server: serves the built client, syncs Yjs documents per room,
// relays presence (awareness) and routes WebRTC voice signaling.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { MAX_PASSWORD_LENGTH, loadPassword, savePassword, verifyPassword, isBlocked, recordFailure } from './auth.js';
import { TERMINAL_ENABLED, RoomTerminal, disposeAllTerminals } from './terminal.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3001;
const WORKSPACES = path.join(DATA, 'workspaces');

// Binary frame types: first byte of every binary message.
const MSG_DOC = 0; // Yjs document update
const MSG_AWARENESS = 1; // y-protocols awareness update (cursors, presence)

fs.mkdirSync(DATA, { recursive: true });

if (TERMINAL_ENABLED) {
  const bar = '!'.repeat(78);
  console.warn(`
${bar}
!! WARNING: ENABLE_TERMINAL=1 -- the shared terminal is ON.
!! Anyone who knows a room's password gets a SHELL ON THIS MACHINE as user
!! running this server. Only use on trusted networks with strong passwords.
${bar}
`);
}

/**
 * @typedef {{
 *   name: string, doc: Y.Doc, conns: Map<import('ws').WebSocket, {id: number}>,
 *   saveTimer: NodeJS.Timeout | null,
 *   password: {salt: string, hash: string} | null,
 *   pending: number,             // connections whose auth is still in flight
 *   authChain: Promise<void>,    // serializes password checks/changes per room
 *   terminal: RoomTerminal | null,
 * }} Room
 */
/** @type {Map<string, Room>} */
const rooms = new Map();

const roomFile = (name) => path.join(DATA, `${name}.ybin`);

function getRoom(name) {
  let room = rooms.get(name);
  if (room) return room;
  const doc = new Y.Doc();
  const file = roomFile(name);
  if (fs.existsSync(file)) {
    try {
      Y.applyUpdate(doc, fs.readFileSync(file));
    } catch (err) {
      console.error(`Could not load room "${name}":`, err);
    }
  }
  let password = null;
  try {
    password = loadPassword(DATA, name);
  } catch (err) {
    console.error(`Could not read password for room "${name}":`, err);
  }
  room = { name, doc, conns: new Map(), saveTimer: null, password, pending: 0, authChain: Promise.resolve(), terminal: null };
  const r = room;
  doc.on('update', () => {
    if (!r.saveTimer) r.saveTimer = setTimeout(() => saveRoom(r), 2000);
  });
  rooms.set(name, room);
  setupTerminal(room);
  return room;
}

/** Terminal feature is available only when enabled AND the room has a password. */
const terminalAvailable = (room) => TERMINAL_ENABLED && room.password !== null;

function setupTerminal(room) {
  if (!terminalAvailable(room) || room.terminal) return;
  room.terminal = new RoomTerminal(room, WORKSPACES, (msg) => broadcast(room, JSON.stringify(msg)));
  room.terminal.startMirroring();
}

function saveRoom(room) {
  if (room.saveTimer) clearTimeout(room.saveTimer);
  room.saveTimer = null;
  try {
    fs.writeFileSync(roomFile(room.name), Y.encodeStateAsUpdate(room.doc));
  } catch (err) {
    console.error(`Could not save room "${room.name}":`, err);
  }
}

function closeRoomIfEmpty(room) {
  if (room.conns.size > 0 || room.pending > 0 || rooms.get(room.name) !== room) return;
  room.terminal?.dispose();
  room.terminal = null;
  saveRoom(room);
  room.doc.destroy();
  rooms.delete(room.name);
}

function frame(type, payload) {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

function broadcast(room, data, except) {
  for (const ws of room.conns.keys()) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
  }
}

// ---------- static file server (production build) ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('No build found. Run "npm run build" first, or use "npm run dev" and open http://localhost:5173');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---------- realtime ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });

function sendJson(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Auth failure: tell the client why, then close with 4001. */
function rejectAuth(ws, code) {
  sendJson(ws, { type: 'error', code });
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(4001, code);
}

/** Give an unlocked room a password and tell everyone already in it. */
async function lockRoom(room, password) {
  room.password = await savePassword(DATA, room.name, password);
  console.log(`Room "${room.name}" is now password protected.`);
  setupTerminal(room);
  broadcast(room, JSON.stringify({ type: 'room-locked', terminal: terminalAvailable(room) }));
}

wss.on('connection', (ws, req) => {
  const params = new URL(req.url ?? '', 'http://x').searchParams;
  const roomName = (params.get('room') ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
  if (!roomName) {
    ws.close(1008, 'invalid room');
    return;
  }
  const room = getRoom(roomName);
  const ip = req.socket.remoteAddress ?? 'unknown';
  /** @type {{id: number} | null} */
  let peer = null;
  let joining = false; // a join is being authenticated (scrypt is async)
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  /** Run fn after any in-flight password work for this room; keeps the room open meanwhile. */
  function queueAuth(fn) {
    room.pending++;
    room.authChain = room.authChain
      .then(fn)
      .catch((err) => {
        console.error(`Auth error in room "${room.name}":`, err);
        sendJson(ws, { type: 'error', code: 'server-error' });
        if (!peer) ws.close(1011, 'server error');
      })
      .finally(() => {
        room.pending--;
        closeRoomIfEmpty(room);
      });
  }

  function admit(id) {
    peer = { id };
    room.conns.set(ws, peer);
    // Full document first, then "welcome" so the client knows it is in sync.
    ws.send(frame(MSG_DOC, Y.encodeStateAsUpdate(room.doc)));
    ws.send(JSON.stringify({ type: 'welcome', locked: room.password !== null, terminal: terminalAvailable(room) }));
    if (terminalAvailable(room) && room.terminal) {
      for (const m of room.terminal.catchUp()) ws.send(JSON.stringify(m));
    }
    broadcast(room, JSON.stringify({ type: 'peer-joined', id }), ws);
  }

  async function authenticateJoin(id, password) {
    if (ws.readyState !== ws.OPEN) return;
    if (room.password) {
      if (!password) return rejectAuth(ws, 'password-required');
      if (isBlocked(ip)) return rejectAuth(ws, 'too-many-attempts');
      const ok = password.length <= MAX_PASSWORD_LENGTH && (await verifyPassword(room.password, password));
      if (!ok) {
        recordFailure(ip);
        return rejectAuth(ws, 'bad-password');
      }
    } else if (password) {
      if (password.length > MAX_PASSWORD_LENGTH) return rejectAuth(ws, 'password-too-long');
      await lockRoom(room, password);
    }
    if (ws.readyState !== ws.OPEN) return;
    admit(id);
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!peer) return; // includes "auth pending"
      const buf = new Uint8Array(data);
      const type = buf[0];
      if (type === MSG_DOC) {
        try {
          Y.applyUpdate(room.doc, buf.subarray(1), ws);
        } catch {
          return; // malformed update; drop it
        }
        broadcast(room, buf, ws);
      } else if (type === MSG_AWARENESS) {
        broadcast(room, buf, ws);
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      if (peer || joining || !Number.isSafeInteger(msg.id)) return;
      if (msg.password !== undefined && typeof msg.password !== 'string') return rejectAuth(ws, 'bad-password');
      joining = true;
      const id = msg.id;
      const password = msg.password ?? '';
      queueAuth(() => authenticateJoin(id, password));
      return;
    }
    if (!peer) return;

    switch (msg.type) {
      case 'signal':
        for (const [other, p] of room.conns) {
          if (p.id === msg.to && other.readyState === other.OPEN) {
            other.send(JSON.stringify({ type: 'signal', from: peer.id, data: msg.data }));
            break;
          }
        }
        break;
      case 'set-password': {
        const pw = msg.password;
        if (typeof pw !== 'string' || pw.length === 0) return sendJson(ws, { type: 'error', code: 'password-required' });
        if (pw.length > MAX_PASSWORD_LENGTH) return sendJson(ws, { type: 'error', code: 'password-too-long' });
        queueAuth(async () => {
          if (room.password) return sendJson(ws, { type: 'error', code: 'already-locked' });
          await lockRoom(room, pw);
        });
        break;
      }
      case 'term-start':
        if (terminalAvailable(room) && room.terminal) room.terminal.start();
        break;
      case 'term-input':
        if (terminalAvailable(room) && room.terminal) room.terminal.input(msg.data);
        break;
      case 'term-kill':
        if (terminalAvailable(room) && room.terminal) room.terminal.kill();
        break;
    }
  });

  ws.on('close', () => {
    if (peer) {
      room.conns.delete(ws);
      broadcast(room, JSON.stringify({ type: 'peer-left', id: peer.id }));
    }
    closeRoomIfEmpty(room);
  });
});

// Drop connections that stopped answering pings.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function shutdown() {
  clearInterval(heartbeat);
  disposeAllTerminals(); // kills shells synchronously (taskkill /T /F on Windows)
  for (const room of rooms.values()) saveRoom(room);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // console window closed (Windows)

server.listen(PORT, () => {
  console.log(`CoCode server listening on http://localhost:${PORT}`);
});
