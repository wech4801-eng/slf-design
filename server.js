/**
 * ASLF — Serveur Node.js auto-hébergé.
 *
 * Aucune dépendance externe (npm install non requis).
 * Sert :
 *   • Les fichiers statiques du site (HTML, CSS, JS, images)
 *   • Une API REST pour les articles et membres (/api/...)
 *   • Un flux SSE temps réel (/api/stream) pour pousser les
 *     mises à jour vers tous les visiteurs connectés.
 *
 * Stockage : data/articles.json et data/members.json
 *
 * Authentification admin :
 *   POST /api/login  body { password }  → renvoie un Bearer token
 *   Toute écriture (POST/PUT/DELETE) sur /api/articles ou /api/members
 *   nécessite l'en-tête  Authorization: Bearer <token>
 *
 * Démarrage : `node server.js`  (ou `npm start`)
 * Variables d'env :
 *   PORT          (par défaut 3456)
 *   ADMIN_PASS    (par défaut "WqTC^+3wjc*v3#Qnbp" — À CHANGER EN PROD)
 *   DATA_DIR      (par défaut "./data")
 */
'use strict';

const http   = require('http');
const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const crypto = require('crypto');

const PORT        = parseInt(process.env.PORT || '3456', 10);
// SÉCURITÉ : ADMIN_PASS doit être passé en variable d'environnement.
// Si absent, on génère un mot de passe aléatoire au démarrage et on l'affiche
// dans le terminal (une seule fois). À sauvegarder dans le gestionnaire de
// secrets du fournisseur (Hostinger hPanel → Avancé → Variables PHP, .env, etc.).
const ADMIN_PASS  = process.env.ADMIN_PASS
  || (() => {
        const p = 'aslf_' + crypto.randomBytes(12).toString('base64url');
        console.warn('\n⚠️  ADMIN_PASS non défini en variable d\'environnement.');
        console.warn('   Mot de passe temporaire généré pour cette session :');
        console.warn('   →  ' + p);
        console.warn('   Définissez ADMIN_PASS pour une valeur stable.\n');
        return p;
      })();
const ADMIN_PASS_BUF = Buffer.from(ADMIN_PASS, 'utf8');
const DATA_DIR    = path.resolve(__dirname, process.env.DATA_DIR || 'data');
const STATIC_DIR  = __dirname;
// Whitelist d'origines pour CORS sur les endpoints d'écriture.
// '*' = tout le monde (insécure mais pratique pour un site statique mono-origine).
const CORS_ALLOWED = (process.env.CORS_ALLOWED || '*').split(',').map(s => s.trim());

// ── Stockage fichier simple (JSON) ────────────────────────────────────────
const FILES = {
  articles: path.join(DATA_DIR, 'articles.json'),
  members:  path.join(DATA_DIR, 'members.json'),
};

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  for (const [name, f] of Object.entries(FILES)) {
    try { await fsp.access(f); }
    catch {
      // Au premier lancement : seeder articles.json depuis seed-articles.json si présent
      if (name === 'articles') {
        try {
          const seed = await fsp.readFile(path.join(STATIC_DIR, 'seed-articles.json'), 'utf8');
          await fsp.writeFile(f, seed);
          console.log('[SEED] articles.json initialisé depuis seed-articles.json');
          continue;
        } catch {}
      }
      await fsp.writeFile(f, '[]');
    }
  }
}

async function readCollection(name) {
  try {
    const raw = await fsp.readFile(FILES[name], 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Lock simple en mémoire pour éviter les écritures concurrentes
const writeLocks = {};
async function writeCollection(name, arr) {
  while (writeLocks[name]) await writeLocks[name];
  writeLocks[name] = fsp.writeFile(FILES[name], JSON.stringify(arr, null, 2));
  try { await writeLocks[name]; } finally { delete writeLocks[name]; }
}

// ── Tokens admin (en mémoire, expirent au redémarrage serveur) ────────────
const tokens = new Map(); // token -> expiresAt (ms)
const TOKEN_TTL = 7 * 24 * 3600 * 1000; // 7 jours

// ── Rate limiting (mémoire, sliding window) ────────────────────────────────
// Anti-bruteforce sur /api/login : 8 tentatives / 15 min par IP, puis 401.
const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX       = 8;
const rateLog = new Map(); // ip -> [timestamp, ...]
function rateLimitLogin(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket?.remoteAddress
          || 'unknown';
  const now = Date.now();
  const log = (rateLog.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  log.push(now);
  rateLog.set(ip, log);
  // Purge périodique des IP inactives
  if (rateLog.size > 5000) {
    for (const [k, v] of rateLog) if (now - v[v.length-1] > RL_WINDOW_MS) rateLog.delete(k);
  }
  return log.length <= RL_MAX;
}

// Comparaison constante anti-timing-attack
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  if (ba.length !== ADMIN_PASS_BUF.length) {
    // Comparaison fictive pour égaliser le temps même quand les tailles diffèrent
    crypto.timingSafeEqual(Buffer.alloc(ADMIN_PASS_BUF.length), ADMIN_PASS_BUF);
    return false;
  }
  return crypto.timingSafeEqual(ba, ADMIN_PASS_BUF);
}

function issueToken() {
  const t = crypto.randomBytes(32).toString('hex');
  tokens.set(t, Date.now() + TOKEN_TTL);
  return t;
}
function checkToken(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+([a-f0-9]+)$/i);
  if (!m) return false;
  const exp = tokens.get(m[1]);
  if (!exp) return false;
  if (Date.now() > exp) { tokens.delete(m[1]); return false; }
  return true;
}

// ── SSE : broadcaster ────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// ── MIME types ───────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.pdf':  'application/pdf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

// ── Helpers HTTP ─────────────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function sendJson(res, status, obj) { send(res, status, obj); }

async function readBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks = [];
    req.on('data', c => {
      len += c.length;
      if (len > maxBytes) { req.destroy(); reject(new Error('Payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(buf.toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Routage statique sécurisé (anti path-traversal) ──────────────────────
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // Anti traversée de répertoire
  if (rel.includes('..') || rel.includes('\\')) { send(res, 400, 'Bad path'); return; }
  const full = path.join(STATIC_DIR, rel);
  if (!full.startsWith(STATIC_DIR)) { send(res, 400, 'Bad path'); return; }

  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) {
      return serveStatic(req, res, path.posix.join(rel, 'index.html'));
    }
    const ext = path.extname(full).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': mime,
      'Content-Length': stat.size,
      // HTML : revalidation à chaque requête mais cacheable (304 si non modifié).
      // Assets : cache 1h navigateur + immutable pour les ressources versionnées ?v=N
      'Cache-Control': ext === '.html'
        ? 'no-cache'
        : 'public, max-age=86400, stale-while-revalidate=604800',
      // Headers de sécurité (s'appliquent aussi aux HTML)
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    };
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  } catch {
    // 404 → servir 404.html si elle existe
    try {
      const fb = await fsp.readFile(path.join(STATIC_DIR, '404.html'), 'utf8');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fb);
    } catch {
      send(res, 404, '404 Not Found');
    }
  }
}

// ── API ──────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  // CORS : pour les GET publics, on autorise tout. Pour les écritures,
  // on n'autorise que les origines whitelist (par défaut '*' rétrocompatible).
  const origin = req.headers.origin || '';
  const isWrite = req.method !== 'GET' && req.method !== 'OPTIONS';
  let allowed = '*';
  if (isWrite && CORS_ALLOWED[0] !== '*') {
    allowed = CORS_ALLOWED.includes(origin) ? origin : 'null';
  }
  res.setHeader('Access-Control-Allow-Origin',  allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /api/login ──
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (!rateLimitLogin(req)) {
      return sendJson(res, 429, { error: 'too_many_attempts', retryAfter: RL_WINDOW_MS / 1000 });
    }
    try {
      const body = await readBody(req);
      if (timingSafeEqualStr(body.password || '', ADMIN_PASS)) {
        const token = issueToken();
        return sendJson(res, 200, { token, expiresIn: TOKEN_TTL });
      }
      return sendJson(res, 401, { error: 'invalid_password' });
    } catch { return sendJson(res, 400, { error: 'bad_request' }); }
  }

  // ── /api/stream (SSE) ──
  if (url.pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    // ping toutes les 25 s pour garder la connexion vivante
    const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // ── /api/articles ──
  const mArt = url.pathname.match(/^\/api\/articles(?:\/([^/]+))?$/);
  if (mArt) {
    const id = mArt[1];
    if (req.method === 'GET') {
      const arts = await readCollection('articles');
      if (id) {
        const a = arts.find(x => x.id === id);
        return a ? sendJson(res, 200, a) : sendJson(res, 404, { error: 'not_found' });
      }
      return sendJson(res, 200, arts);
    }
    // Mutations → token requis
    if (!checkToken(req)) return sendJson(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' || req.method === 'PUT') {
      let body;
      try { body = await readBody(req); }
      catch { return sendJson(res, 400, { error: 'bad_body' }); }
      if (!body.id) return sendJson(res, 400, { error: 'id_required' });
      const arts = await readCollection('articles');
      const idx = arts.findIndex(a => a.id === body.id);
      if (idx === -1) arts.unshift(body);
      else arts[idx] = body;
      await writeCollection('articles', arts);
      broadcast('articles-updated', { id: body.id });
      return sendJson(res, 200, body);
    }
    if (req.method === 'DELETE' && id) {
      const arts = await readCollection('articles');
      const next = arts.filter(a => a.id !== id);
      if (next.length === arts.length) return sendJson(res, 404, { error: 'not_found' });
      await writeCollection('articles', next);
      broadcast('articles-updated', { id, deleted: true });
      return sendJson(res, 204, '');
    }
  }

  // ── /api/articles/:id/view (compteur public) ──
  const mView = url.pathname.match(/^\/api\/articles\/([^/]+)\/view$/);
  if (mView && req.method === 'POST') {
    const arts = await readCollection('articles');
    const a = arts.find(x => x.id === mView[1]);
    if (!a) return sendJson(res, 404, { error: 'not_found' });
    a.views = (a.views || 0) + 1;
    await writeCollection('articles', arts);
    return sendJson(res, 200, { views: a.views });
  }

  // ── /api/members (mêmes patterns) ──
  const mMem = url.pathname.match(/^\/api\/members(?:\/([^/]+))?$/);
  if (mMem) {
    const id = mMem[1];
    if (req.method === 'GET') {
      if (!checkToken(req)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, await readCollection('members'));
    }
    if (!checkToken(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST' || req.method === 'PUT') {
      let body;
      try { body = await readBody(req); }
      catch { return sendJson(res, 400, { error: 'bad_body' }); }
      if (!body.id) return sendJson(res, 400, { error: 'id_required' });
      const mems = await readCollection('members');
      const idx = mems.findIndex(m => m.id === body.id);
      if (idx === -1) mems.unshift(body);
      else mems[idx] = body;
      await writeCollection('members', mems);
      broadcast('members-updated', { id: body.id });
      return sendJson(res, 200, body);
    }
    if (req.method === 'DELETE' && id) {
      const mems = await readCollection('members');
      const next = mems.filter(m => m.id !== id);
      await writeCollection('members', next);
      broadcast('members-updated', { id, deleted: true });
      return sendJson(res, 204, '');
    }
  }

  sendJson(res, 404, { error: 'api_route_not_found' });
}

// ── Server ───────────────────────────────────────────────────────────────
(async () => {
  await ensureDataDir();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      console.error('[ERR]', e);
      send(res, 500, { error: 'internal' });
    }
  });
  server.listen(PORT, () => {
    console.log(`ASLF server prêt sur http://localhost:${PORT}`);
    console.log(`  Données     : ${DATA_DIR}`);
    console.log(`  Auth admin  : POST /api/login { password: "..." }`);
    console.log(`  Temps réel  : GET /api/stream (SSE)`);
  });
})();
