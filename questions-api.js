// questions-api.js
// API de preguntas propias (PostgreSQL). Funciona con http nativo o con Express.
// Variables de entorno: DATABASE_URL (obligatoria) y ADMIN_CODE (por defecto 1999).
const crypto = require('crypto');
const { Pool } = require('pg');

const DB = process.env.DATABASE_URL;
const CODE = String(process.env.ADMIN_CODE || '1999');
const MODES = ['normal', 'profundo', 'gracioso'];

const pool = DB
  ? new Pool({
      connectionString: DB,
      ssl: /localhost|127\.0\.0\.1/.test(DB) ? false : { rejectUnauthorized: false },
      max: 3,
    })
  : null;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS custom_questions (
           id SERIAL PRIMARY KEY,
           mode TEXT NOT NULL,
           category TEXT NOT NULL,
           question TEXT NOT NULL,
           options JSONB NOT NULL,
           created_at TIMESTAMPTZ DEFAULT now()
         )`
      );
      await pool.query(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
      await seedOnce();
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

// Inserta filas [{mode,k,q,o}] por lotes (dentro de una transacción ya abierta).
async function insertMany(client, rows) {
  const CH = 400;
  for (let i = 0; i < rows.length; i += CH) {
    const part = rows.slice(i, i + CH);
    const vals = [];
    const ph = part.map((r, j) => {
      vals.push(r.mode, r.k, r.q, JSON.stringify(r.o));
      const b = j * 4;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
    });
    await client.query(`INSERT INTO custom_questions (mode, category, question, options) VALUES ${ph.join(',')}`, vals);
  }
}

// Carga UNA SOLA VEZ las preguntas originales (questions-seed.json) en la base de datos.
// Si ya había preguntas propias, se conservan detrás de las originales (mismo orden que antes).
// Cuando Render borra la base de datos (cada mes) se vuelve a cargar sola.
async function seedOnce() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7311)');
    const done = await client.query("SELECT 1 FROM app_meta WHERE key='seeded'");
    if (!done.rowCount) {
      const seed = require('./questions-seed.json');
      const ex = await client.query('SELECT mode, category, question, options FROM custom_questions ORDER BY id');
      const mine = ex.rows.map((r) => ({ mode: r.mode, k: r.category, q: r.question, o: r.options }));
      await client.query('TRUNCATE custom_questions RESTART IDENTITY');
      await insertMany(client, seed.concat(mine));
      await client.query("INSERT INTO app_meta (key, value) VALUES ('seeded', now()::text)");
      console.log('questions-api: cargadas ' + seed.length + ' preguntas originales (+' + mine.length + ' propias)');
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// --- Límite de intentos fallidos de código (por IP) ---
const fails = new Map();
function ipOf(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function blocked(ip) {
  const f = fails.get(ip);
  return f && f.n >= 10 && Date.now() - f.t < 15 * 60 * 1000;
}
function fail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t > 15 * 60 * 1000) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
}
function codeOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 10000) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body); // Express con json()
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) {
        reject(new Error('too_big'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function clean(b) {
  if (!b || !MODES.includes(b.mode)) return null;
  const k = String(b.k || '').trim().slice(0, 40);
  const q = String(b.q || '').trim().slice(0, 120);
  if (!Array.isArray(b.o)) return null;
  const o = b.o.map((x) => String(x || '').trim().slice(0, 40)).filter(Boolean);
  if (!k || !q || o.length < 2 || o.length > 4) return null;
  return { mode: b.mode, k, q, o };
}

const row = (r) => ({ id: r.id, mode: r.mode, k: r.category, q: r.question, o: r.options });

// Devuelve true si la petición era de /api/questions (y ya la ha respondido).
async function handle(req, res) {
  const path = (req.url || '').split('?')[0];
  const m = path.match(/^\/api\/questions(?:\/(auth|restore|\d+))?\/?$/);
  if (!m) return false;
  try {
    if (!pool) return send(res, 500, { error: 'no_database' }), true;
    await init();
    const sub = m[1];
    const method = req.method;

    if (method === 'GET' && !sub) {
      const r = await pool.query('SELECT * FROM custom_questions ORDER BY id');
      return send(res, 200, { questions: r.rows.map(row) }), true;
    }

    // Todo lo demás exige el código
    const ip = ipOf(req);
    if (blocked(ip)) return send(res, 429, { error: 'too_many' }), true;
    if (!codeOk(req.headers['x-admin-code'])) {
      fail(ip);
      return send(res, 401, { error: 'unauthorized' }), true;
    }
    fails.delete(ip);

    if (method === 'POST' && sub === 'auth') return send(res, 200, { ok: true }), true;

    if (method === 'POST' && sub === 'restore') {
      // Sustituye TODAS las preguntas por las de un backup.
      const b = await readBody(req, 3 * 1024 * 1024);
      const list = Array.isArray(b) ? b : b && b.questions;
      if (!Array.isArray(list) || list.length > 5000) return send(res, 400, { error: 'invalid' }), true;
      const rows = list.map(clean).filter(Boolean);
      if (!rows.length) return send(res, 400, { error: 'invalid' }), true;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(7311)');
        await client.query('TRUNCATE custom_questions RESTART IDENTITY');
        await insertMany(client, rows);
        await client.query(
          "INSERT INTO app_meta (key, value) VALUES ('seeded', now()::text) ON CONFLICT (key) DO NOTHING"
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      return send(res, 200, { ok: true, restored: rows.length, skipped: list.length - rows.length }), true;
    }

    if (method === 'POST' && !sub) {
      const c = clean(await readBody(req));
      if (!c) return send(res, 400, { error: 'invalid' }), true;
      const r = await pool.query(
        'INSERT INTO custom_questions (mode, category, question, options) VALUES ($1,$2,$3,$4) RETURNING *',
        [c.mode, c.k, c.q, JSON.stringify(c.o)]
      );
      return send(res, 201, { question: row(r.rows[0]) }), true;
    }

    if (method === 'PUT' && /^\d+$/.test(sub || '')) {
      const c = clean(await readBody(req));
      if (!c) return send(res, 400, { error: 'invalid' }), true;
      const r = await pool.query(
        'UPDATE custom_questions SET mode=$1, category=$2, question=$3, options=$4 WHERE id=$5 RETURNING *',
        [c.mode, c.k, c.q, JSON.stringify(c.o), +sub]
      );
      if (!r.rowCount) return send(res, 404, { error: 'not_found' }), true;
      return send(res, 200, { question: row(r.rows[0]) }), true;
    }

    if (method === 'DELETE' && /^\d+$/.test(sub || '')) {
      const r = await pool.query('DELETE FROM custom_questions WHERE id=$1', [+sub]);
      return send(res, r.rowCount ? 200 : 404, r.rowCount ? { ok: true } : { error: 'not_found' }), true;
    }

    return send(res, 405, { error: 'method' }), true;
  } catch (e) {
    console.error('questions-api:', e.message);
    return send(res, e.message === 'bad_json' || e.message === 'too_big' ? 400 : 500, { error: 'server' }), true;
  }
}

// Se llama al arrancar el servidor: prepara la base de datos sin esperar a la primera visita.
function warm() {
  if (!pool) return;
  init().catch((e) => console.error('questions-api (arranque):', e.message));
}

module.exports = { handle, warm };
