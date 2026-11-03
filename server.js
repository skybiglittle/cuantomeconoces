// Servidor de "¿Cuánto me conoces?" para Render (Web Service gratuito).
// Sirve la app (public/index.html) y hace de relé de las salas en directo por WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { handle: questionsApi, warm: warmQuestions } = require('./questions-api');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const MAX_PLAYERS = 2;
const MAX_GROUP = 200; // salas de grupo: sin límite práctico (tope técnico de seguridad)
const MAX_PRESENCE_BYTES = 4096;

const server = http.createServer(async (req, res) => {
  // API de preguntas propias (editor): /api/questions
  if (await questionsApi(req, res)) return;
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  // Servir archivos de la carpeta public según la URL
const PUBLIC_DIR = path.join(__dirname, 'public');

const pathname = decodeURIComponent(
  new URL(req.url, 'http://localhost').pathname
);

const filename = pathname === '/'
  ? 'index.html'
  : pathname.replace(/^\/+/, '');

const filePath = path.resolve(PUBLIC_DIR, filename);

// Evitar acceder a archivos fuera de public
if (!filePath.startsWith(PUBLIC_DIR + path.sep) &&
    filePath !== path.join(PUBLIC_DIR, 'index.html')) {
  res.writeHead(403);
  return res.end('Acceso denegado');
}

fs.readFile(filePath, (err, data) => {
  if (err) {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.end('Archivo no encontrado');
  }

  const ext = path.extname(filePath);

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };

  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });

  res.end(data);
});
});

const wss = new WebSocketServer({ server, maxPayload: 8192 });
const rooms = new Map(); // nombre de sala -> Set de sockets
let nextId = 1;

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(name) {
  const set = rooms.get(name);
  if (!set) return;
  const peers = [...set].map((w) => ({ id: w.pid, p: w.pres }));
  for (const w of set) send(w, { t: 'peers', peers });
}

function leave(ws) {
  const name = ws.room;
  if (!name) return;
  ws.room = null;
  const set = rooms.get(name);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(name);
  else broadcast(name);
}

// Agrupa los cambios de presencia (60 ms) para no saturar con muchos jugadores.
const pending = new Map();
function schedule(name) {
  if (pending.has(name)) return;
  pending.set(name, setTimeout(() => { pending.delete(name); broadcast(name); }, 60));
}

wss.on('connection', (ws) => {
  ws.pid = 'p' + nextId++;
  ws.alive = true;
  ws.pres = {};
  ws.room = null;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.pid });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'join') {
      if (ws.room) return;
      const name = String(m.room || '');
      if (!ROOM_RE.test(name)) return send(ws, { t: 'err', code: 'invalid_room' });
      const cid = String(m.cid || '').slice(0, 32);
      let set = rooms.get(name);
      if (!set) { set = new Set(); rooms.set(name, set); }
      // Reconexión del mismo jugador: sustituye su socket anterior.
      for (const w of [...set]) {
        if (cid && w.cid === cid) { set.delete(w); w.room = null; try { w.terminate(); } catch {} }
      }
      // Limpia sockets muertos antes de decidir si la sala está llena.
      for (const w of [...set]) {
        if (w.readyState !== 1) { set.delete(w); w.room = null; }
      }
      if (set.size >= (name.startsWith('cmg-') ? MAX_GROUP : MAX_PLAYERS)) {
        if (set.size === 0) rooms.delete(name);
        return send(ws, { t: 'err', code: 'room_full' });
      }
      ws.cid = cid;
      ws.room = name;
      set.add(ws);
      broadcast(name);
      return;
    }

    if (m.t === 'pres' && ws.room && m.p && typeof m.p === 'object' && !Array.isArray(m.p)) {
      const next = { ...ws.pres };
      for (const k of Object.keys(m.p)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) continue;
        if (m.p[k] === null) delete next[k];
        else next[k] = m.p[k];
      }
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_PRESENCE_BYTES) return;
      ws.pres = next;
      schedule(ws.room);
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// Latido: elimina conexiones muertas y evita que el proxy cierre las inactivas.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { try { ws.terminate(); } catch {} continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

server.listen(PORT, () => {
  console.log('Servidor listo en el puerto ' + PORT);
  warmQuestions(); // crea las tablas y carga las preguntas originales (una sola vez) al arrancar
});
