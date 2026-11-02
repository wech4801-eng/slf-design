'use strict';
/**
 * ASLF — Serveur web autonome (Node.js ≥ 20, aucune dépendance).
 *
 *  • Sert le site public (dossier public/) compressé (Brotli/Gzip) et mis en cache
 *  • Injecte les articles directement dans les pages : aucun aller-retour réseau
 *  • API d'administration protégée par session (cookie HttpOnly)
 *  • Photos envoyées dans data/uploads/, sauvegarde quotidienne dans data/backups/
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');

const env = require('./env');
const store = require('./store');
const auth = require('./auth');
const { ZipWriter } = require('./zip');
const SLFConfig = require('../public/assets/config.js');
const pkg = require('../package.json');

const { httpError } = store;

// ── En-têtes de sécurité ─────────────────────────────────────────────────────
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com',
  "media-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

function isHttps(req) {
  return !!req.socket.encrypted || (env.TRUST_PROXY && /^https/i.test(String(req.headers['x-forwarded-proto'] || '')));
}

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function clientIp(req) {
  if (env.TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'inconnu';
}

// ── Réponses ─────────────────────────────────────────────────────────────────
function pickEncoding(req, size) {
  if (size < 1024) return null;
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

function compress(buf, enc) {
  return enc === 'br'
    ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : zlib.gzipSync(buf, { level: 6 });
}

/** Envoie un corps texte, compressé si le navigateur l'accepte (versions précalculées si fournies). */
function sendBody(req, res, status, body, headers, pre) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const enc = pickEncoding(req, raw.length);
  const out = enc ? (pre && pre[enc]) || compress(raw, enc) : raw;
  res.writeHead(status, {
    ...headers,
    ...(enc ? { 'Content-Encoding': enc } : {}),
    Vary: 'Accept-Encoding',
    'Content-Length': out.length,
  });
  res.end(req.method === 'HEAD' ? undefined : out);
}

function sendJson(req, res, status, obj, extra = {}) {
  sendBody(req, res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
}

function sendText(req, res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  sendBody(req, res, status, text, { 'Content-Type': type, ...extra });
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

// ── Lecture du corps des requêtes ────────────────────────────────────────────
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (len > max) { req.resume(); return reject(httpError(413, 'Fichier trop lourd.')); }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(httpError(413, 'Fichier trop lourd.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, max = 2 * 1024 * 1024) {
  if (!/application\/json/i.test(req.headers['content-type'] || '')) throw httpError(415, 'Format de requête invalide.');
  const buf = await readRaw(req, max);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'Données illisibles.'); }
}

// ── Fichiers statiques (gardés en mémoire, déjà compressés) ──────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};
const TEXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml', '.webmanifest']);
const fileCache = new Map();

/** Résout un chemin d'URL dans un dossier en refusant toute sortie du dossier et les fichiers cachés. */
function resolveInside(base, urlPath) {
  if (urlPath.includes('\0') || /(^|\/)\.[^/]/.test(urlPath)) return null;
  const full = path.resolve(base, '.' + path.posix.normalize('/' + urlPath));
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

async function loadFile(full) {
  let st;
  try { st = await fsp.stat(full); } catch { return null; }
  if (!st.isFile()) return null;
  const ext = path.extname(full).toLowerCase();
  const cached = fileCache.get(full);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const entry = {
    full, ext, size: st.size, mtimeMs: st.mtimeMs,
    type: MIME[ext] || 'application/octet-stream',
    etag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`,
    lastModified: st.mtime.toUTCString(),
  };
  if (TEXT.has(ext) && st.size <= 2 * 1024 * 1024) {
    entry.raw = await fsp.readFile(full);
    if (entry.raw.length >= 1024) entry.pre = { br: compress(entry.raw, 'br'), gzip: compress(entry.raw, 'gzip') };
    fileCache.set(full, entry);
  }
  return entry;
}

function cacheControl(urlPath, query, ext) {
  if (ext === '.html') return 'no-cache';
  if (urlPath.startsWith('/uploads/') || query.has('v') || ext === '.woff2') return 'public, max-age=31536000, immutable';
  if (/^\.(jpe?g|png|gif|webp|avif|svg|ico)$/.test(ext)) return 'public, max-age=2592000, stale-while-revalidate=86400';
  return 'public, max-age=3600, stale-while-revalidate=86400';
}

function serveFile(req, res, entry, urlPath, query) {
  const headers = {
    'Content-Type': entry.type,
    'Cache-Control': cacheControl(urlPath, query, entry.ext),
    ETag: entry.etag,
    'Last-Modified': entry.lastModified,
  };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
  if (entry.raw) return sendBody(req, res, 200, entry.raw, headers, entry.pre);
  res.writeHead(200, { ...headers, 'Content-Length': entry.size });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(entry.full);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ── Pages HTML : injection des articles ──────────────────────────────────────
const SECTION_PAGES = new Map(SLFConfig.SECTIONS.map((s) => [s.page.replace('.html', ''), s.key]));
const htmlCache = new Map();

// JSON sûr dans une balise <script> : « < » et séparateurs de ligne Unicode échappés
const ESCAPE_U = String.fromCharCode(92) + 'u';
const UNSAFE_IN_SCRIPT = new RegExp('[<' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const jsonForHtml = (obj) => JSON.stringify(obj).replace(UNSAFE_IN_SCRIPT, (c) => ESCAPE_U + c.charCodeAt(0).toString(16).padStart(4, '0'));
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function absoluteUrl(req, p) {
  if (/^https?:/i.test(p)) return p;
  const base = env.SITE_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
  return base + (p.startsWith('/') ? p : '/' + p);
}

/** Données injectées selon la page : liste d'articles ou article complet. */
function pageData(page, query, admin) {
  const pub = store.publicArticles();
  if (page === 'index') return { key: 'index', data: { articles: pub.list.slice(0, 6), total: pub.list.length } };
  if (page === 'news') return { key: 'news', data: { articles: pub.list.slice(0, 24), total: pub.list.length } };
  if (page === 'article') {
    const id = String(query.get('id') || '').slice(0, 120);
    const a = id ? store.getArticle(id) : null;
    if (!a || !(store.isPublic(a) || admin) || (a.deletedAt && !admin)) {
      return { key: 'article:none', data: { article: null }, status: id ? 404 : 200 };
    }
    const related = pub.list.filter((x) => x.id !== a.id && (x.section === a.section || (a.categoryKey && x.categoryKey === a.categoryKey))).slice(0, 3);
    return {
      key: `article:${a.id}:${a.updatedAt}:${a.views}:${admin ? 1 : 0}`,
      data: { article: store.full(a, false), related, draft: !store.isPublic(a), admin: !!admin },
      article: a,
    };
  }
  const section = SECTION_PAGES.get(page);
  if (section) return { key: `section:${section}`, data: { section, articles: pub.list.filter((x) => x.section === section) } };
  return null;
}

function setMeta(html, attr, name, value) {
  const re = new RegExp(`(<meta\\s+${attr}="${name}"\\s+content=")[^"]*"`, 'i');
  return html.replace(re, `$1${escHtml(value)}"`);
}

function renderHtml(req, src, page, query, admin) {
  let html = src;
  if (env.SITE_URL && env.SITE_URL !== env.ORIGINAL_SITE_URL) html = html.split(env.ORIGINAL_SITE_URL).join(env.SITE_URL);
  const pd = pageData(page, query, admin);
  if (pd && pd.article) {
    const a = pd.article;
    const s = store.summary(a, false);
    const title = `${a.seoTitle || a.title} · ASLF`;
    const desc = (a.metaDesc || s.chapeau || '').slice(0, 200);
    const img = absoluteUrl(req, s.coverImage || '/images/comite_executif.jpg');
    const link = absoluteUrl(req, `/article.html?id=${encodeURIComponent(a.slug || a.id)}`);
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escHtml(title)}</title>`);
    html = setMeta(html, 'name', 'description', desc);
    for (const [k, v] of [['og:title', title], ['og:description', desc], ['og:image', img], ['og:url', link], ['og:type', 'article']]) html = setMeta(html, 'property', k, v);
    for (const [k, v] of [['twitter:title', title], ['twitter:description', desc], ['twitter:image', img]]) html = setMeta(html, 'name', k, v);
    html = html.replace(/(<link\s+rel="canonical"\s+href=")[^"]*"/i, `$1${escHtml(link)}"`);
    if (!store.isPublic(a)) html = html.replace('<head>', '<head>\n  <meta name="robots" content="noindex" />');
  }
  if (pd) {
    const tag = `<script id="aslf-data" type="application/json">${jsonForHtml(pd.data)}</script>`;
    html = html.includes('</body>') ? html.replace('</body>', tag + '\n</body>') : html + tag;
  }
  return { html, key: pd ? pd.key : 'static', status: pd ? pd.status : undefined };
}

/**
 * Cache navigateur sans entretien : chaque « fichier?v=… » cité dans une page
 * reçoit une version calculée d'après sa date et sa taille. Un fichier modifié
 * change donc d'adresse, et les visiteurs reçoivent toujours la bonne version.
 */
function versionAssets(html, pageRel) {
  const pageDir = path.posix.dirname(pageRel);
  return html.replace(/((?:href|src)=")([^"?#:]+)\?v=[^"#]*/g, (m, pre, p) => {
    const full = resolveInside(env.PUBLIC_DIR, p.startsWith('/') ? p : path.posix.join(pageDir, p));
    if (!full) return m;
    try {
      const st = fs.statSync(full);
      return `${pre}${p}?v=${st.size.toString(36)}${Math.floor(st.mtimeMs).toString(36)}`;
    } catch { return m; }
  });
}

/** Envoie une page HTML (compressée, avec ETag calculé sur le contenu final). */
function sendHtml(req, res, status, html, cacheControl) {
  const etag = `W/"${crypto.createHash('sha1').update(html).digest('base64url').slice(0, 22)}"`;
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl, ETag: etag };
  if (status === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  let pre = htmlCache.get(etag);
  if (!pre) {
    const buf = Buffer.from(html);
    pre = { br: compress(buf, 'br'), gzip: compress(buf, 'gzip') };
    if (htmlCache.size >= 300) htmlCache.delete(htmlCache.keys().next().value);
    htmlCache.set(etag, pre);
  }
  sendBody(req, res, status, html, headers, pre);
}

function servePage(req, res, entry, rel, query, admin) {
  const { html, status } = renderHtml(req, entry.raw.toString('utf8'), path.basename(rel, '.html'), query, admin);
  sendHtml(req, res, status || 200, versionAssets(html, rel), admin ? 'private, no-cache' : 'no-cache');
}

async function notFound(req, res) {
  const entry = await loadFile(path.join(env.PUBLIC_DIR, '404.html'));
  // <base> : les chemins relatifs de la page d'erreur fonctionnent quelle que soit l'adresse demandée
  if (entry && entry.raw) return sendHtml(req, res, 404, versionAssets(entry.raw.toString('utf8'), '/404.html').replace('<head>', '<head><base href="/">'), 'no-cache');
  return sendText(req, res, 404, 'Page introuvable');
}

// ── Anciennes adresses de l'administration ───────────────────────────────────
const LEGACY = {
  '/admin-login.html': '/admin/connexion.html',
  '/admin-dashboard.html': '/admin/',
  '/admin-editor.html': '/admin/article.html',
  '/admin-membres.html': '/admin/membres.html',
  '/admin-medias.html': '/admin/photos.html',
  '/admin-categories.html': '/admin/',
  '/admin-parametres.html': '/admin/reglages.html',
};

// ── Sitemap et robots ────────────────────────────────────────────────────────
const STATIC_PAGES = ['', 'news.html', ...SLFConfig.SECTIONS.map((s) => s.page).filter((p) => p !== 'news.html')];

function sitemap(req) {
  const urls = STATIC_PAGES.map((p) => `  <url><loc>${escHtml(absoluteUrl(req, '/' + p))}</loc></url>`);
  for (const a of store.publicArticles().list) {
    urls.push(`  <url><loc>${escHtml(absoluteUrl(req, '/article.html?id=' + encodeURIComponent(a.slug)))}</loc><lastmod>${escHtml(String(a.date).slice(0, 10))}</lastmod></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function robots(req) {
  return `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${absoluteUrl(req, '/sitemap.xml')}\n`;
}

// ── API ──────────────────────────────────────────────────────────────────────
function requireAdmin(req) {
  const key = auth.sessionOf(req);
  if (!key) throw httpError(401, 'Votre session a expiré. Reconnectez-vous.');
  return key;
}

/** Protection CSRF : en-tête propre au site + origine identique. */
function checkSameOrigin(req) {
  if (req.headers['x-requested-with'] !== 'ASLF') throw httpError(403, 'Requête refusée.');
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host;
    try { host = new URL(origin).host; } catch { throw httpError(403, 'Requête refusée.'); }
    if (host !== req.headers.host && !(env.SITE_URL && origin === env.SITE_URL)) throw httpError(403, 'Requête refusée.');
  }
}

async function streamBackup(req, res) {
  const day = new Date().toISOString().slice(0, 10);
  await store.flushAll();
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="sauvegarde-aslf-${day}.zip"`,
    'Cache-Control': 'no-store',
  });
  const zip = new ZipWriter(res);
  await zip.add('LISEZ-MOI.txt', Buffer.from(
    `Sauvegarde du site ASLF du ${day}\n\n` +
    'Contenu : articles.json (articles), members.json (membres), messages.json (messages reçus), uploads/ (photos).\n' +
    'Pour restaurer : voir la section « Restaurer une sauvegarde » du guide DEPLOIEMENT-VPS.md.\n'));
  for (const f of ['articles.json', 'members.json', 'messages.json']) {
    try { await zip.add(f, await fsp.readFile(path.join(env.DATA_DIR, f))); } catch {}
  }
  for (const u of await store.listUploads()) {
    const file = store.uploadPath(u.url);
    if (!file) continue;
    try { await zip.add(u.url.slice(1), await fsp.readFile(file), new Date(u.date)); } catch {}
  }
  await zip.finish();
}

async function status() {
  const list = store.adminList();
  const uploads = await store.listUploads();
  let free = null;
  try { const s = await fsp.statfs(env.DATA_DIR); free = s.bavail * s.bsize; } catch {}
  return {
    version: pkg.version,
    articles: {
      enLigne: list.filter((a) => a.isPublic && !a.deletedAt).length,
      brouillons: list.filter((a) => !a.isPublic && !a.deletedAt).length,
      corbeille: list.filter((a) => a.deletedAt).length,
    },
    membres: store.listMembers().length,
    messagesNonLus: store.unreadMessages(),
    photos: { nombre: uploads.length, poids: uploads.reduce((n, u) => n + u.size, 0) },
    disqueLibre: free,
    derniereSauvegarde: await store.lastBackup(),
    demarrage: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    memoire: Math.round(process.memoryUsage().rss / 1048576),
    systeme: `${os.type()} ${os.release()} · Node ${process.versions.node}`,
  };
}

const contactLog = new Map();

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  let mm;

  // ── Public ──
  if (p === '/api/health') return sendJson(req, res, 200, { ok: true, version: pkg.version, uptime: Math.round(process.uptime()) });

  if (p === '/api/articles' && m === 'GET') {
    const pub = store.publicArticles();
    const section = url.searchParams.get('section') || '';
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '24', 10) || 24));
    const etag = `${pub.etag.slice(0, -1)}-${section}-${offset}-${limit}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    const list = section ? pub.list.filter((a) => a.section === section) : pub.list;
    return sendJson(req, res, 200, { total: list.length, articles: list.slice(offset, offset + limit) },
      { 'Cache-Control': 'public, max-age=30', ETag: etag });
  }

  mm = /^\/api\/articles\/([\w-]{1,120})$/.exec(p);
  if (mm && m === 'GET') {
    const a = store.getArticle(mm[1]);
    if (!a || !store.isPublic(a)) throw httpError(404, 'Article introuvable.');
    return sendJson(req, res, 200, store.full(a, false), { 'Cache-Control': 'public, max-age=30' });
  }
  mm = /^\/api\/articles\/([\w-]{1,120})\/vue$/.exec(p);
  if (mm && m === 'POST') {
    const a = store.getArticle(mm[1]);
    const views = a ? store.countView(a.id, clientIp(req)) : null;
    return sendJson(req, res, views === null ? 404 : 200, { views });
  }

  // ── Formulaire de contact (public) ──
  if (p === '/api/contact' && m === 'POST') {
    checkSameOrigin(req);
    const body = await readJson(req, 32 * 1024);
    // Champ piège invisible : rempli uniquement par les robots
    if (body.site) return sendJson(req, res, 200, { ok: true });
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (contactLog.get(ip) || []).filter((t) => now - t < 3600 * 1000);
    if (recent.length >= 5) throw httpError(429, 'Vous avez déjà envoyé plusieurs messages. Réessayez dans une heure, ou écrivez-nous par e-mail.');
    store.addMessage(body);
    recent.push(now);
    contactLog.set(ip, recent);
    if (contactLog.size > 10000) contactLog.clear();
    return sendJson(req, res, 201, { ok: true });
  }

  // ── Session ──
  if (p === '/api/session' && m === 'GET') return sendJson(req, res, 200, { connected: !!auth.sessionOf(req) });

  if (p === '/api/login' && m === 'POST') {
    checkSameOrigin(req);
    const ip = clientIp(req);
    const wait = auth.loginBlocked(ip);
    if (wait) throw httpError(429, `Trop d’essais. Patientez ${wait} minute${wait > 1 ? 's' : ''} avant de réessayer.`);
    const body = await readJson(req, 4096);
    if (!auth.verifyPassword(String(body.password || ''), auth.passwordHash)) {
      auth.recordFailure(ip);
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
      throw httpError(401, 'Mot de passe incorrect. Vérifiez les majuscules et réessayez.');
    }
    auth.clearFailures(ip);
    return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(req, auth.createSession()) });
  }

  if (p === '/api/logout' && m === 'POST') {
    checkSameOrigin(req);
    auth.destroySession(auth.sessionOf(req));
    return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(req, null) });
  }

  // ── Administration ──
  if (!p.startsWith('/api/admin/')) throw httpError(404, 'Adresse inconnue.');
  const session = requireAdmin(req);
  if (m !== 'GET' && m !== 'HEAD') checkSameOrigin(req);
  const ap = p.slice('/api/admin'.length);

  if (ap === '/articles' && m === 'GET') return sendJson(req, res, 200, store.adminList());
  if (ap === '/articles' && m === 'POST') return sendJson(req, res, 201, store.saveArticle(await readJson(req)));
  mm = /^\/articles\/([\w-]{1,120})(\/restaurer)?$/.exec(ap);
  if (mm) {
    const id = mm[1];
    if (mm[2]) {
      if (m !== 'POST') throw httpError(405, 'Méthode non autorisée.');
      store.restoreArticle(id);
      return sendJson(req, res, 200, { ok: true });
    }
    if (m === 'GET') {
      const a = store.getArticle(id);
      if (!a) throw httpError(404, 'Article introuvable.');
      return sendJson(req, res, 200, store.full(a, true));
    }
    if (m === 'PUT') return sendJson(req, res, 200, store.saveArticle(await readJson(req), id));
    if (m === 'DELETE') {
      if (url.searchParams.get('definitif') === '1') store.destroyArticle(id); else store.trashArticle(id);
      return sendJson(req, res, 200, { ok: true });
    }
  }

  if (ap === '/photos' && m === 'GET') return sendJson(req, res, 200, await store.listUploads());
  if (ap === '/photos' && m === 'POST') return sendJson(req, res, 201, await store.saveUpload(await readRaw(req, 10 * 1024 * 1024 + 1)));
  if (ap === '/photos' && m === 'DELETE') {
    await store.deleteUpload(String(url.searchParams.get('url') || ''));
    return sendJson(req, res, 200, { ok: true });
  }

  if (ap === '/membres' && m === 'GET') return sendJson(req, res, 200, store.listMembers());
  if (ap === '/membres' && m === 'POST') return sendJson(req, res, 201, store.saveMember(await readJson(req, 64 * 1024)));
  mm = /^\/membres\/([\w-]{1,60})$/.exec(ap);
  if (mm && m === 'PUT') return sendJson(req, res, 200, store.saveMember(await readJson(req, 64 * 1024), mm[1]));
  if (mm && m === 'DELETE') { store.deleteMember(mm[1]); return sendJson(req, res, 200, { ok: true }); }

  if (ap === '/messages' && m === 'GET') return sendJson(req, res, 200, store.listMessages());
  mm = /^\/messages\/([\w-]{1,60})$/.exec(ap);
  if (mm && m === 'PUT') { store.setMessageRead(mm[1], (await readJson(req, 1024)).lu); return sendJson(req, res, 200, { ok: true }); }
  if (mm && m === 'DELETE') { store.deleteMessage(mm[1]); return sendJson(req, res, 200, { ok: true }); }

  if (ap === '/mot-de-passe' && m === 'POST') {
    const body = await readJson(req, 4096);
    if (!auth.verifyPassword(String(body.current || ''), auth.passwordHash)) throw httpError(400, 'Le mot de passe actuel est incorrect.');
    await auth.setPassword(String(body.next || ''));
    auth.destroyOtherSessions(session);
    return sendJson(req, res, 200, { ok: true });
  }

  if (ap === '/etat' && m === 'GET') return sendJson(req, res, 200, await status());
  if (ap === '/sauvegarde' && m === 'GET') return streamBackup(req, res);

  throw httpError(404, 'Adresse inconnue.');
}

// ── Routage principal ────────────────────────────────────────────────────────
async function handle(req, res) {
  securityHeaders(req, res);
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD, POST, PUT, DELETE' });
    return res.end();
  }
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch { return sendText(req, res, 400, 'Adresse invalide'); }

  if (pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(req, res, 405, 'Méthode non autorisée');

  if (pathname === '/sitemap.xml') return sendText(req, res, 200, sitemap(req), 'application/xml; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
  if (pathname === '/robots.txt') return sendText(req, res, 200, robots(req), 'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
  if (LEGACY[pathname]) return redirect(res, LEGACY[pathname] + url.search, 301);
  if (pathname === '/admin') return redirect(res, '/admin/', 301);
  if (pathname === '/index.html') return redirect(res, '/' + url.search, 301);

  // Photos envoyées depuis l'administration
  if (pathname.startsWith('/uploads/')) {
    const file = store.uploadPath(pathname);
    const entry = file ? await loadFile(file) : null;
    return entry ? serveFile(req, res, entry, pathname, url.searchParams) : notFound(req, res);
  }

  let rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
  let full = resolveInside(env.PUBLIC_DIR, rel);
  if (!full) return notFound(req, res);
  // Adresses sans « .html » : /contact → contact.html
  if (!path.extname(full)) { rel += '.html'; full += '.html'; }
  if (path.basename(full) === 'seed-articles.json') return notFound(req, res);

  const entry = await loadFile(full);
  if (!entry) return notFound(req, res);

  if (entry.ext !== '.html') return serveFile(req, res, entry, pathname, url.searchParams);

  const admin = !!auth.sessionOf(req);
  if (rel.startsWith('/admin/')) {
    // Administration : jamais en cache ; redirection vers la connexion si besoin
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (rel === '/admin/connexion.html') {
      if (admin) return redirect(res, '/admin/');
    } else if (!admin) {
      return redirect(res, '/admin/connexion.html?suite=' + encodeURIComponent(path.posix.basename(rel) + url.search));
    }
    return sendHtml(req, res, 200, versionAssets(entry.raw.toString('utf8'), rel), 'no-store');
  }
  return servePage(req, res, entry, rel, url.searchParams, admin);
}

// ── Démarrage ────────────────────────────────────────────────────────────────
function start() {
  store.init();
  auth.init();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const code = err.status || 500;
      if (code >= 500) console.error(`[erreur] ${req.method} ${req.url} :`, err.stack || err);
      if (res.headersSent) { res.destroy(); return; }
      const message = err.expose ? err.message : 'Une erreur est survenue sur le serveur. Réessayez dans un instant.';
      if (String(req.url).startsWith('/api/')) sendJson(req, res, code, { error: message });
      else sendText(req, res, code, message);
    });
  });
  server.requestTimeout = 120 * 1000;
  server.headersTimeout = 20 * 1000;
  server.keepAliveTimeout = 10 * 1000;

  server.listen(env.PORT, env.HOST, () => {
    console.log(`ASLF ${pkg.version} — site en ligne sur http://${env.HOST === '0.0.0.0' ? 'localhost' : env.HOST}:${env.PORT}`);
    console.log(`  Données : ${env.DATA_DIR}`);
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Le port ${env.PORT} est déjà utilisé.` : e.message);
    process.exit(1);
  });

  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Arrêt demandé (${signal}) : enregistrement des données…`);
    server.close();
    setTimeout(() => process.exit(0), 5000).unref();
    await Promise.all([store.flushAll(), auth.flushAll()]).catch(() => {});
    process.exit(0);
  }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('[erreur non gérée]', e));
  return server;
}

module.exports = { start };
