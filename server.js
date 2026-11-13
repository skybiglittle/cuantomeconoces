// Servidor de "¿Cuánto me conoces?" para Render.
// Sirve cualquier archivo de la carpeta public según la URL solicitada
// y mantiene el relé de salas en directo por WebSocket.
// Además inyecta un botón 🎮 con el menú de todos los juegos (.html de public)
// en cada página HTML. Para que una página NO lo muestre, pon <!-- no-menu --> en ella.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { handle: questionsApi, warm: warmQuestions } = require('./questions-api');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const MAX_PLAYERS = 200;
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

function gamesList() {
  let files = [];
  try { files = listHtml(PUBLIC_DIR); } catch {}
  return files.map((rel) => ({
    href: '/' + rel.split('/').map(encodeURIComponent).join('/'),
    title: pageTitle(rel) || rel,
  }));
}

const MENU_SNIPPET = '<script>(function(){if(window.__gm)return;window.__gm=1;'
  + 'var d=matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches,b=document.createElement("button"),p=document.createElement("div");'
  + 'b.textContent="\\uD83C\\uDFAE";b.setAttribute("aria-label","Men\\u00fa de juegos");'
  + 'b.style.cssText="position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;width:46px;height:46px;border-radius:50%;border:0;font-size:22px;cursor:pointer;background:#7c4dff;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3)";'
  + 'p.style.cssText="display:none;position:fixed;right:12px;bottom:calc(66px + env(safe-area-inset-bottom,0px));z-index:9999;width:min(300px,calc(100vw - 24px));max-height:60vh;overflow:auto;padding:8px;border-radius:16px;font:15px system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.3);border:1px solid "+(d?"#352c40":"#eadfe6")+";background:"+(d?"#221c2b":"#fff")+";color:"+(d?"#f3eef7":"#2a2230");'
  + 'function open(){p.innerHTML="Cargando\\u2026";p.style.display="block";'
  + 'fetch("/_games",{cache:"no-store"}).then(function(r){return r.json()}).then(function(l){p.innerHTML="";'
  + 'l.forEach(function(g){var a=document.createElement("a"),h=decodeURIComponent(g.href),cur=h===location.pathname||h.replace(/\\.html?$/,"")===location.pathname;'
  + 'a.href=g.href;a.textContent=g.title+(cur?"  \\u2022":"");'
  + 'a.style.cssText="display:block;padding:10px 12px;border-radius:10px;text-decoration:none;color:inherit;font-weight:"+(cur?"700":"500");'
  + 'if(cur)a.style.background="rgba(124,77,255,.15)";p.appendChild(a)});'
  + 'if(!l.length)p.textContent="No hay juegos."}).catch(function(){p.textContent="No se pudo cargar el men\\u00fa."})}'
  + 'b.onclick=function(e){e.stopPropagation();if(p.style.display==="none")open();else p.style.display="none"};'
  + 'document.addEventListener("click",function(e){if(!p.contains(e.target))p.style.display="none"});'
  + 'document.body.appendChild(p);document.body.appendChild(b)})();</script>';

function injectMenu(html) {
  if (html.includes('<!-- no-menu -->')) return html;
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? html + MENU_SNIPPET : html.slice(0, i) + MENU_SNIPPET + html.slice(i);
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

  // Lista de juegos para el menú.
  if (pathname === '/_games') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(gamesList()));
  }

  // La raíz muestra index.html; cualquier otra ruta apunta a su archivo dentro de public.
  let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
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
    const isHtml = contentType.startsWith('text/html');
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(isHtml ? injectMenu(data.toString('utf8')) : data);
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

        // Reenviar mensajes a otros jugadores de la misma sala
    if (m.t === 'direct' && ws.room && typeof m.to === 'string' && m.p &&
        typeof m.p === 'object' && !Array.isArray(m.p)) {

      const set = rooms.get(ws.room);
      if (!set) return;

      if (Buffer.byteLength(JSON.stringify(m.p)) > 4096) return;

      const target = [...set].find(peer => peer.pid === m.to);
      if (!target || target === ws || target.readyState !== 1) return;

      send(target, { t: 'direct', from: ws.pid, p: m.p });
      return;
    }

    // TU BLOQUE PRES ORIGINAL
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
