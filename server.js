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
const MAX_PRESENCE_BYTES = 4096;

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

// SERVIDOR HTTP
const server = http.createServer(async (req, res) => {

  // API de preguntas
  if (await questionsApi(req, res)) return;

  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(req.url, 'http://localhost').pathname
    );
  } catch {
    res.writeHead(400, {
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.end('URL no válida');
  }

  // Comprobación de funcionamiento
  if (pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.end('ok');
  }

  // La raíz muestra index.html.
  // Las demás rutas buscan su archivo correspondiente en public.

  let relativePath = pathname === '/'
    ? 'index.html'
    : pathname.replace(/^\/+/, '');

  // Si termina en /, busca index.html dentro de esa carpeta.
  if (relativePath.endsWith('/')) {
    relativePath += 'index.html';
  }

  // Si no tiene extensión, añade .html.
  else if (!path.extname(relativePath)) {
    relativePath += '.html';
  }

  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  // Evita acceder a archivos fuera de la carpeta public.
  if (
    filePath !== PUBLIC_DIR &&
    !filePath.startsWith(PUBLIC_DIR + path.sep)
  ) {
    res.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.end('Acceso denegado');
  }

  fs.readFile(filePath, (err, data) => {

    if (err) {
      const status =
        err.code === 'ENOENT' || err.code === 'ENOTDIR'
          ? 404
          : 500;

      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache'
      });

      return res.end(
        status === 404
          ? 'No se encuentra esa página o archivo en public'
          : 'Error al leer el archivo'
      );
    }

    const contentType =
      MIME_TYPES[path.extname(filePath).toLowerCase()] ||
      'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': contentType.startsWith('text/html')
        ? 'no-cache'
        : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });

    res.end(data);
  });
});

// WEBSOCKETS
const wss = new WebSocketServer({
  server,
  maxPayload: 8192
});

const rooms = new Map();
let nextId = 1;

function send(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(name) {
  const set = rooms.get(name);

  if (!set) return;

  const peers = [...set].map((w) => ({
    id: w.pid,
    p: w.pres
  }));

  for (const w of set) {
    send(w, {
      t: 'peers',
      peers
    });
  }
}

function leave(ws) {
  const name = ws.room;

  if (!name) return;

  ws.room = null;

  const set = rooms.get(name);

  if (!set) return;

  set.delete(ws);

  if (set.size === 0) {
    rooms.delete(name);
  } else {
    broadcast(name);
  }
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

// CONEXIONES
wss.on('connection', (ws) => {

  ws.pid = 'p' + nextId++;
  ws.alive = true;
  ws.pres = {};
  ws.room = null;

  ws.on('pong', () => {
    ws.alive = true;
  });

  send(ws, {
    t: 'hello',
    id: ws.pid
  });

  ws.on('message', (raw) => {

    let m;

    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!m || typeof m !== 'object') return;

    // ENTRAR EN UNA SALA
    if (m.t === 'join') {

      if (ws.room) return;

      const name = String(m.room || '');

      if (!ROOM_RE.test(name)) {
        return send(ws, {
          t: 'err',
          code: 'invalid_room'
        });
      }

      const cid = String(m.cid || '').slice(0, 32);

      let set = rooms.get(name);

      if (!set) {
        set = new Set();
        rooms.set(name, set);
      }

      // Reconexión del mismo jugador:
      // sustituye su socket anterior.
      for (const w of [...set]) {

        if (cid && w.cid === cid) {
          set.delete(w);
          w.room = null;

          try {
            w.terminate();
          } catch {}
        }
      }

      // Limpia sockets muertos antes de comprobar el aforo.
      for (const w of [...set]) {

        if (w.readyState !== 1) {
          set.delete(w);
          w.room = null;
        }
      }

      // Límites según el tipo de sala.
      const maxPlayers = name.startsWith('cmt-')
        ? MAX_TITLE_PLAYERS
        : (name.startsWith('cmg-') || name.startsWith('cmd-'))
          ? MAX_GROUP
          : MAX_PLAYERS;

      if (set.size >= maxPlayers) {

        if (set.size === 0) {
          rooms.delete(name);
        }

        return send(ws, {
          t: 'err',
          code: 'room_full'
        });
      }

      ws.cid = cid;
      ws.room = name;

      set.add(ws);

      broadcast(name);

      return;
    }

    // ACTUALIZAR PRESENCIA
    if (
      m.t === 'pres' &&
      ws.room &&
      m.p &&
      typeof m.p === 'object' &&
      !Array.isArray(m.p)
    ) {

      const next = {
        ...ws.pres
      };

      for (const k of Object.keys(m.p)) {

        if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) {
          continue;
        }

        if (m.p[k] === null) {
          delete next[k];
        } else {
          next[k] = m.p[k];
        }
      }

      if (
        Buffer.byteLength(JSON.stringify(next)) >
        MAX_PRESENCE_BYTES
      ) {
        return;
      }

      ws.pres = next;

      schedule(ws.room);
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// LATIDO: elimina conexiones muertas.
setInterval(() => {

  for (const ws of wss.clients) {

    if (!ws.alive) {
      try {
        ws.terminate();
      } catch {}

      continue;
    }

    ws.alive = false;

    try {
      ws.ping();
    } catch {}
  }

}, 25000);

// ARRANQUE
server.listen(PORT, () => {

  console.log(
    'Servidor listo en el puerto ' + PORT
  );

  warmQuestions();
});
