// Servidor de "¿Cuánto me conoces?" para Render.
// Sirve cualquier archivo de la carpeta public según la URL solicitada
// y mantiene el relé de salas en directo por WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { handle: questionsApi, warm: warmQuestions } = require('./questions-api');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const MAX_PLAYERS = 2;
const MAX_GROUP = 200;
const MAX_TITLE_PLAYERS = 30;
const MAX_PRESENCE_BYTES = 16384;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---------- Menú de páginas ----------
function listHtml(dir, base = '') {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(listHtml(path.join(dir, e.name), rel));
    else if (/\.html?$/i.test(e.name)) out.push(rel);
  }
  return out.sort();
}

function pageTitle(rel) {
  try {
    const txt = fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').slice(0, 4000);
    const m = txt.match(/<title>([^<]*)<\/title>/i);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function menuPage() {
  let files = [];
  try { files = listHtml(PUBLIC_DIR); } catch {}
  const items = files.map((rel) => {
    const href = '/' + rel.split('/').map(encodeURIComponent).join('/');
    const title = pageTitle(rel) || rel;
    return '<a class="it" href="' + escHtml(href) + '"><b>' + escHtml(title) + '</b><small>' + escHtml(rel) + '</small></a>';
  }).join('') || '<p>No hay archivos .html en la carpeta public.</p>';
  return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Juegos</title>'
    + '<style>'
    + ':root{--bg:#faf7f5;--card:#fff;--tx:#2a2230;--mut:#7a7083;--ac:#e0457b;--bd:#eadfe6}'
    + '@media (prefers-color-scheme:dark){:root{--bg:#17131c;--card:#221c2b;--tx:#f3eef7;--mut:#a99fb5;--bd:#352c40}}'
    + '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + 'main{max-width:560px;margin:0 auto;padding:24px 16px 40px}h1{font-size:28px;margin:8px 0 16px}'
    + '.it{display:block;background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:16px 18px;margin:10px 0;color:var(--tx);text-decoration:none}'
    + '.it:hover,.it:active{border-color:var(--ac)}.it b{display:block;font-size:18px}.it small{color:var(--mut)}'
    + '</style></head><body><main><h1>🎮 Elige un juego</h1>' + items + '</main></body></html>';
}

const server = http.createServer(async (req, res) => {
  // API de preguntas propias (editor): /api/questions
  if (await questionsApi(req, res)) return;

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('URL no válida');
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  // La raíz muestra un menú con todos los .html de public.
  // El juego de siempre queda en /index y la foto censurada en /censura.
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(menuPage());
  }

  let relativePath = pathname.replace(/^\/+/, '');
  if (relativePath.endsWith('/')) relativePath += 'index.html';
  else if (!path.extname(relativePath)) relativePath += '.html';

  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Acceso denegado');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const status = err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 404 : 500;
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      return res.end(status === 404 ? 'No se encuentra esa página o archivo en public' : 'Error al leer el archivo');
    }

    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': contentType.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 32768 });
const rooms = new Map();
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

// Agrupa los cambios de presencia para no saturar con muchos jugadores.
const pending = new Map();
function schedule(name) {
  if (pending.has(name)) return;
  pending.set(name, setTimeout(() => {
    pending.delete(name);
    broadcast(name);
  }, 60));
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
        if (cid && w.cid === cid) {
          set.delete(w);
          w.room = null;
          try { w.terminate(); } catch {}
        }
      }

      // Limpia sockets muertos antes de comprobar el aforo.
      for (const w of [...set]) {
        if (w.readyState !== 1) {
          set.delete(w);
          w.room = null;
        }
      }

      const maxPlayers = (name.startsWith('cmt-') || name.startsWith('cmb-') || name.startsWith('cmz-'))
        ? MAX_TITLE_PLAYERS
        : (name.startsWith('cmg-') || name.startsWith('cmd-'))
          ? MAX_GROUP
          : MAX_PLAYERS;

      if (set.size >= maxPlayers) {
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
    if (!ws.alive) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

server.listen(PORT, () => {
  console.log('Servidor listo en el puerto ' + PORT);
  warmQuestions();
});
