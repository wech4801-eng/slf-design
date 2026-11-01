'use strict';
/**
 * Stockage : articles, membres et photos.
 *
 * Les données vivent en mémoire et sont écrites sur disque (data/*.json) de
 * façon atomique : fichier temporaire puis renommage, avec copie .bak de la
 * version précédente. Une coupure de courant ne peut donc pas laisser un
 * fichier à moitié écrit.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const env = require('./env');
const { sanitize, toText, safeUrl } = require('../public/assets/sanitize.js');
const SLFConfig = require('../public/assets/config.js');

// ── Fichiers JSON ────────────────────────────────────────────────────────────
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, 'w', 0o600);
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, file);
}

class JsonDoc {
  constructor(name, fallback) {
    this.file = path.join(env.DATA_DIR, name);
    this.fallback = fallback;
    this.data = null;
    this.timer = null;
    this.dirty = false;
    this.chain = Promise.resolve();
  }

  load() {
    for (const f of [this.file, this.file + '.bak']) {
      let raw;
      try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      try {
        this.data = JSON.parse(raw);
        if (f !== this.file) { console.warn(`[données] ${path.basename(this.file)} illisible : copie de secours utilisée.`); this.dirty = true; }
        return this;
      } catch {
        console.error(`[données] ${f} est corrompu.`);
      }
    }
    if (fs.existsSync(this.file)) {
      // Ne jamais écraser un fichier corrompu : on le met de côté pour analyse
      const aside = `${this.file}.corrompu-${Date.now()}`;
      fs.renameSync(this.file, aside);
      console.error(`[données] Fichier mis de côté : ${aside}`);
    }
    this.data = this.fallback();
    this.dirty = true;
    return this;
  }

  /** Programme une écriture (regroupe les modifications rapprochées). */
  save(delay = 150) {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    clearTimeout(this.timer);
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const json = JSON.stringify(this.data);
    this.chain = this.chain.then(async () => {
      try { await fsp.copyFile(this.file, this.file + '.bak'); } catch {}
      await writeAtomic(this.file, json);
    }).catch((e) => {
      this.dirty = true;
      console.error(`[données] Échec d'écriture de ${this.file} :`, e.message);
    });
    return this.chain;
  }
}

// ── Utilitaires ──────────────────────────────────────────────────────────────
const STATUSES = new Set(['publié', 'brouillon', 'planifié']);
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
// Texte brut d'une ligne (titres, résumés) : balises retirées, espaces normalisés
const plain = (v, max) => toText(str(v, max * 2)).slice(0, max);
const nowIso = () => new Date().toISOString();
const isoOrNull = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const countWords = (s) => (s ? s.split(' ').filter(Boolean).length : 0);

function slugify(s) {
  return str(s, 200).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}

/** Chemin d'image interne normalisé en absolu (« images/x.jpg » → « /images/x.jpg »). */
function cleanImageUrl(v) {
  const u = safeUrl(str(v, 2000), 'src');
  if (!u) return '';
  if (/^https?:/i.test(u) || u.startsWith('/')) return u;
  return '/' + u.replace(/^\.\//, '');
}

function cleanContentUrls(html) {
  // Chemins relatifs du site → absolus, pour un affichage correct depuis /admin/
  return html.replace(/(<img src=")(?!https?:|\/)(?:\.\/)?([^"]+)"/g, '$1/$2"');
}

const VIDEO_RE = [
  [/(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,20})/i, (id) => ({ type: 'youtube', url: `https://www.youtube-nocookie.com/embed/${id}` })],
  [/vimeo\.com\/(?:video\/)?(\d{4,12})/i, (id) => ({ type: 'vimeo', url: `https://player.vimeo.com/video/${id}` })],
];
function parseVideo(url) {
  const s = str(url, 500);
  for (const [re, make] of VIDEO_RE) { const m = re.exec(s); if (m) return make(m[1]); }
  return null;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

// ── Photos envoyées ──────────────────────────────────────────────────────────
const MAX_UPLOAD = 10 * 1024 * 1024;
const UPLOAD_URL_RE = /^\/uploads\/(\d{4})\/(\d{2})\/([\w-]{8,40})\.(webp|jpg|png|gif)$/;

function imageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function uploadTarget(ext) {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const name = crypto.randomBytes(12).toString('base64url');
  return {
    dir: path.join(env.UPLOADS_DIR, yyyy, mm),
    file: path.join(env.UPLOADS_DIR, yyyy, mm, `${name}.${ext}`),
    url: `/uploads/${yyyy}/${mm}/${name}.${ext}`,
  };
}

async function saveUpload(buf) {
  if (!buf || !buf.length) throw httpError(400, 'Fichier vide.');
  if (buf.length > MAX_UPLOAD) throw httpError(413, 'Photo trop lourde (10 Mo maximum).');
  const ext = imageType(buf);
  if (!ext) throw httpError(415, 'Ce fichier n’est pas une photo (JPG, PNG, WebP ou GIF).');
  const t = uploadTarget(ext);
  await fsp.mkdir(t.dir, { recursive: true });
  await fsp.writeFile(t.file, buf, { mode: 0o644 });
  return { url: t.url, size: buf.length };
}

/** Convertit une image « data:… » (anciennes versions du site) en fichier. */
function dataUrlToFile(dataUrl) {
  const m = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return '';
  const buf = Buffer.from(m[1], 'base64');
  const ext = imageType(buf);
  if (!ext) return '';
  const t = uploadTarget(ext);
  fs.mkdirSync(t.dir, { recursive: true });
  fs.writeFileSync(t.file, buf, { mode: 0o644 });
  return t.url;
}

function uploadPath(url) {
  const m = UPLOAD_URL_RE.exec(url || '');
  return m ? path.join(env.UPLOADS_DIR, m[1], m[2], `${m[3]}.${m[4]}`) : null;
}

// ── Articles ─────────────────────────────────────────────────────────────────
const articlesDoc = new JsonDoc('articles.json', () => {
  try { return JSON.parse(fs.readFileSync(path.join(env.PUBLIC_DIR, 'seed-articles.json'), 'utf8')); }
  catch { return []; }
});
const membersDoc = new JsonDoc('members.json', () => []);

let version = 1;
const byId = new Map();
const bySlug = new Map();

function reindex() {
  byId.clear(); bySlug.clear();
  for (const a of articlesDoc.data) { byId.set(a.id, a); if (a.slug) bySlug.set(a.slug, a); }
  version++;
}

function uniqueSlug(base, id) {
  const root = base || 'article';
  let slug = root;
  for (let n = 2; bySlug.has(slug) && bySlug.get(slug).id !== id; n++) slug = `${root}-${n}`;
  return slug;
}

function isPublic(a, now = Date.now()) {
  if (!a || a.deletedAt) return false;
  if (a.status === 'publié') return true;
  return a.status === 'planifié' && !!a.publishAt && Date.parse(a.publishAt) <= now;
}

/** Date affichée et utilisée pour le tri : date de publication réelle. */
function articleDate(a) {
  return (a.status === 'planifié' && a.publishAt) || a.publishedAt || a.createdAt || a.updatedAt;
}

/**
 * Valide et nettoie un article reçu de l'éditeur. Rien de ce que le navigateur
 * envoie n'est conservé sans contrôle (vues, dates, identifiant…).
 */
function normalizeArticle(input, existing) {
  const now = nowIso();
  let status = STATUSES.has(input.status) ? input.status : 'brouillon';
  const content = cleanContentUrls(sanitize(input.content || ''));
  const title = plain(input.title, 200) || 'Sans titre';
  const id = existing ? existing.id : newId('art');
  const publishAt = status === 'planifié' ? isoOrNull(input.publishAt) : null;
  if (status === 'planifié' && !publishAt) status = 'brouillon';
  const coverImage = cleanImageUrl(input.coverImage);
  const a = {
    id,
    slug: uniqueSlug(slugify(input.slug) || slugify(title), id),
    title,
    chapeau: plain(input.chapeau, 600),
    content,
    coverImage,
    coverThumb: coverImage ? cleanImageUrl(input.coverThumb) : '',
    coverAlt: plain(input.coverAlt, 200),
    section: SLFConfig.section(input.section).key,
    categoryKey: SLFConfig.category(input.categoryKey) ? input.categoryKey : '',
    tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => str(t, 40)).filter(Boolean).slice(0, 12),
    author: str(input.author, 80) || 'Rédaction ASLF',
    status,
    publishAt,
    seoTitle: plain(input.seoTitle, 80),
    metaDesc: plain(input.metaDesc, 220),
    gallery: (Array.isArray(input.gallery) ? input.gallery : []).map(cleanImageUrl).filter(Boolean).slice(0, 80),
    videos: (Array.isArray(input.videos) ? input.videos : [])
      .map((v) => parseVideo(typeof v === 'string' ? v : v && v.url)).filter(Boolean).slice(0, 10),
    words: countWords(toText(content)),
    views: existing ? existing.views || 0 : 0,
    createdAt: existing ? existing.createdAt || now : now,
    updatedAt: now,
    publishedAt: existing ? existing.publishedAt || null : null,
    deletedAt: existing ? existing.deletedAt || null : null,
  };
  if (a.status === 'publié' && !a.publishedAt) a.publishedAt = now;
  return a;
}

function summary(a, admin) {
  const sec = SLFConfig.section(a.section);
  const cat = SLFConfig.category(a.categoryKey);
  const s = {
    id: a.id,
    slug: a.slug,
    title: a.title,
    chapeau: a.chapeau || toText(a.content).slice(0, 220),
    coverImage: a.coverImage || '',
    coverThumb: a.coverThumb || a.coverImage || '',
    coverAlt: a.coverAlt || '',
    section: sec.key,
    sectionLabel: sec.label,
    sectionPage: sec.page,
    categoryKey: cat ? cat.key : '',
    categoryLabel: cat ? cat.label : sec.label,
    tone: cat ? cat.tone : 'actions',
    author: a.author || 'Rédaction ASLF',
    date: articleDate(a),
    readMinutes: Math.max(1, Math.round(((a.words || 0) + countWords(a.chapeau)) / 200)),
    views: a.views || 0,
  };
  if (admin) {
    s.status = a.status;
    s.publishAt = a.publishAt;
    s.updatedAt = a.updatedAt;
    s.deletedAt = a.deletedAt;
    s.isPublic = isPublic(a);
  }
  return s;
}

function full(a, admin) {
  return {
    ...summary(a, admin),
    content: a.content,
    tags: a.tags || [],
    gallery: a.gallery || [],
    videos: a.videos || [],
    seoTitle: a.seoTitle || '',
    metaDesc: a.metaDesc || '',
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

const byDateDesc = (x, y) => Date.parse(articleDate(y)) - Date.parse(articleDate(x));

// Liste publique mise en cache jusqu'à la prochaine modification
// (ou jusqu'à l'heure de la prochaine publication programmée)
let publicCache = null;
function publicArticles() {
  const now = Date.now();
  if (publicCache && publicCache.version === version && now < publicCache.validUntil) return publicCache;
  let validUntil = Infinity;
  for (const a of articlesDoc.data) {
    if (!a.deletedAt && a.status === 'planifié' && a.publishAt) {
      const t = Date.parse(a.publishAt);
      if (t > now && t < validUntil) validUntil = t;
    }
  }
  const list = articlesDoc.data.filter((a) => isPublic(a, now)).sort(byDateDesc).map((a) => summary(a, false));
  publicCache = { version, validUntil, list, json: JSON.stringify(list), etag: `"a${version}-${list.length}"` };
  return publicCache;
}

function getArticle(idOrSlug) {
  return byId.get(idOrSlug) || bySlug.get(idOrSlug) || null;
}

function adminList() {
  return articlesDoc.data.slice()
    .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
    .map((a) => summary(a, true));
}

function saveArticle(input, id) {
  const existing = id ? byId.get(id) : null;
  if (id && !existing) throw httpError(404, 'Article introuvable.');
  const a = normalizeArticle(input || {}, existing);
  if (existing) Object.assign(existing, a); else articlesDoc.data.unshift(a);
  reindex();
  articlesDoc.save();
  return full(existing || a, true);
}

function setDeleted(id, deleted) {
  const a = byId.get(id);
  if (!a) throw httpError(404, 'Article introuvable.');
  a.deletedAt = deleted ? nowIso() : null;
  version++;
  articlesDoc.save();
}
const trashArticle = (id) => setDeleted(id, true);
const restoreArticle = (id) => setDeleted(id, false);

function destroyArticle(id) {
  const before = articlesDoc.data.length;
  articlesDoc.data = articlesDoc.data.filter((a) => a.id !== id);
  if (articlesDoc.data.length === before) throw httpError(404, 'Article introuvable.');
  reindex();
  articlesDoc.save();
}

// ── Compteur de vues (en mémoire, écrit sur disque toutes les minutes) ───────
const VIEW_WINDOW = 6 * 3600 * 1000;
const seenViews = new Map();
let viewsDirty = false;
function countView(id, ip) {
  const a = byId.get(id);
  if (!a || !isPublic(a)) return null;
  const key = ip + '|' + id;
  const now = Date.now();
  const last = seenViews.get(key);
  if (!last || now - last > VIEW_WINDOW) {
    seenViews.set(key, now);
    a.views = (a.views || 0) + 1;
    viewsDirty = true;
    if (seenViews.size > 50000) {
      for (const [k, t] of seenViews) if (now - t > VIEW_WINDOW) seenViews.delete(k);
      if (seenViews.size > 50000) seenViews.clear();
    }
  }
  return a.views;
}
setInterval(() => { if (viewsDirty) { viewsDirty = false; articlesDoc.save(0); } }, 60 * 1000).unref();

// ── Membres ──────────────────────────────────────────────────────────────────
const MEMBER_FIELDS = { prenom: 80, nom: 80, email: 160, telephone: 40, ville: 80, statut: 40, cotisation: 40, adhesion: 10, notes: 2000 };

function normalizeMember(input, existing) {
  const m = { id: existing ? existing.id : newId('mbr') };
  for (const [k, max] of Object.entries(MEMBER_FIELDS)) m[k] = str(input[k], max);
  // Compatibilité avec l'ancien format (« name » d'un seul tenant)
  if (!m.nom && !m.prenom && input.name) m.nom = str(input.name, 80);
  if (!m.prenom && !m.nom) throw httpError(400, 'Indiquez au moins un nom ou un prénom.');
  if (m.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) throw httpError(400, 'Cette adresse e-mail ne semble pas correcte.');
  if (m.adhesion && !/^\d{4}-\d{2}-\d{2}$/.test(m.adhesion)) m.adhesion = '';
  m.createdAt = existing ? existing.createdAt || nowIso() : nowIso();
  m.updatedAt = nowIso();
  return m;
}

function listMembers() {
  return membersDoc.data.slice().sort((a, b) =>
    (a.nom || '').localeCompare(b.nom || '', 'fr') || (a.prenom || '').localeCompare(b.prenom || '', 'fr'));
}
function saveMember(input, id) {
  const idx = id ? membersDoc.data.findIndex((m) => m.id === id) : -1;
  if (id && idx === -1) throw httpError(404, 'Membre introuvable.');
  const m = normalizeMember(input || {}, idx >= 0 ? membersDoc.data[idx] : null);
  if (idx >= 0) membersDoc.data[idx] = m; else membersDoc.data.push(m);
  membersDoc.save();
  return m;
}
function deleteMember(id) {
  const before = membersDoc.data.length;
  membersDoc.data = membersDoc.data.filter((m) => m.id !== id);
  if (membersDoc.data.length === before) throw httpError(404, 'Membre introuvable.');
  membersDoc.save();
}

// ── Messages du formulaire de contact ────────────────────────────────────────
const messagesDoc = new JsonDoc('messages.json', () => []);
const SUBJECTS = {
  adhesion: 'Adhésion', don: 'Don', benevole: 'Bénévolat', projet: 'Projet', presse: 'Presse',
  partenariat: 'Partenariat', information: 'Demande d’information', autre: 'Autre',
};

function addMessage(input) {
  const m = {
    id: newId('msg'),
    nom: plain(input.nom, 120),
    email: str(input.email, 160),
    telephone: str(input.telephone, 40),
    sujet: SUBJECTS[input.sujet] ? input.sujet : 'autre',
    message: str(input.message, 5000),
    createdAt: nowIso(),
    lu: false,
  };
  if (!m.nom) throw httpError(400, 'Indiquez votre nom.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) throw httpError(400, 'Indiquez une adresse e-mail valide pour que nous puissions vous répondre.');
  if (m.message.length < 5) throw httpError(400, 'Écrivez votre message.');
  messagesDoc.data.unshift(m);
  if (messagesDoc.data.length > 5000) messagesDoc.data.length = 5000;
  messagesDoc.save();
  return m;
}
function listMessages() {
  return messagesDoc.data.map((m) => ({ ...m, sujetLabel: SUBJECTS[m.sujet] || 'Autre' }));
}
function unreadMessages() { return messagesDoc.data.filter((m) => !m.lu).length; }
function setMessageRead(id, lu) {
  const m = messagesDoc.data.find((x) => x.id === id);
  if (!m) throw httpError(404, 'Message introuvable.');
  m.lu = !!lu;
  messagesDoc.save();
}
function deleteMessage(id) {
  const before = messagesDoc.data.length;
  messagesDoc.data = messagesDoc.data.filter((m) => m.id !== id);
  if (messagesDoc.data.length === before) throw httpError(404, 'Message introuvable.');
  messagesDoc.save();
}

// ── Photos : inventaire et suppression ───────────────────────────────────────
function uploadUsage() {
  const used = new Map();
  const add = (url, a) => {
    if (!UPLOAD_URL_RE.test(url || '')) return;
    if (!used.has(url)) used.set(url, []);
    const list = used.get(url);
    if (!list.some((x) => x.id === a.id)) list.push({ id: a.id, title: a.title, deleted: !!a.deletedAt });
  };
  for (const a of articlesDoc.data) {
    add(a.coverImage, a); add(a.coverThumb, a);
    (a.gallery || []).forEach((u) => add(u, a));
    for (const m of (a.content || '').matchAll(/src="(\/uploads\/[^"]+)"/g)) add(m[1], a);
  }
  return used;
}

async function listUploads() {
  const used = uploadUsage();
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p, rel + '/' + e.name); continue; }
      const url = '/uploads' + rel + '/' + e.name;
      if (!UPLOAD_URL_RE.test(url)) continue;
      const st = await fsp.stat(p);
      out.push({ url, size: st.size, date: st.mtime.toISOString(), usedBy: used.get(url) || [] });
    }
  }
  await walk(env.UPLOADS_DIR, '');
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

async function deleteUpload(url) {
  const file = uploadPath(url);
  if (!file) throw httpError(400, 'Photo inconnue.');
  const users = uploadUsage().get(url);
  if (users && users.length) throw httpError(409, 'Cette photo est utilisée dans un article : retirez-la de l’article d’abord.');
  try { await fsp.unlink(file); } catch (e) { if (e.code === 'ENOENT') throw httpError(404, 'Photo introuvable.'); throw e; }
}

// ── Migration des anciennes données ──────────────────────────────────────────
function migrate() {
  let changed = 0;
  const fixUrl = (u) => {
    if (typeof u !== 'string' || !u) return u;
    if (u.startsWith('data:image/')) return dataUrlToFile(u);
    return u.replace(/(images\/livret\/\d+)\.png/, '$1.webp');
  };
  for (const a of articlesDoc.data) {
    const before = JSON.stringify(a);
    a.coverImage = fixUrl(a.coverImage);
    a.gallery = (Array.isArray(a.gallery) ? a.gallery : []).map(fixUrl).filter(Boolean);
    if (typeof a.content === 'string') {
      a.content = a.content.replace(/src="(data:image\/[^"]+)"/g, (_, d) => `src="${fixUrl(d)}"`)
        .replace(/(images\/livret\/\d+)\.png/g, '$1.webp');
    }
    // Les vidéos enregistrées dans le fichier (base64) ne sont plus prises en charge
    a.videos = (Array.isArray(a.videos) ? a.videos : []).filter((v) => v && typeof v.url === 'string' && !v.url.startsWith('data:'));
    // Normalisation complète : filtre HTML, champs manquants, adresse (slug)…
    const n = normalizeArticle(a, a);
    n.updatedAt = a.updatedAt || n.updatedAt;
    n.publishedAt = a.publishedAt || (a.status === 'publié' ? a.createdAt || a.updatedAt || null : null);
    for (const k of Object.keys(a)) if (!(k in n)) delete a[k];
    Object.assign(a, n);
    bySlug.set(a.slug, a);
    if (JSON.stringify(a) !== before) changed++;
  }
  return changed;
}

// ── Corbeille et sauvegardes automatiques ────────────────────────────────────
function purgeTrash() {
  const limit = Date.now() - env.TRASH_DAYS * 86400 * 1000;
  const before = articlesDoc.data.length;
  articlesDoc.data = articlesDoc.data.filter((a) => !a.deletedAt || Date.parse(a.deletedAt) > limit);
  if (articlesDoc.data.length !== before) { reindex(); articlesDoc.save(); }
}

async function dailyBackup() {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(env.BACKUPS_DIR, day);
  await flushAll();
  if (!fs.existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const f of ['articles.json', 'members.json', 'messages.json']) {
      try { await fsp.copyFile(path.join(env.DATA_DIR, f), path.join(dir, f)); } catch {}
    }
  }
  const limit = Date.now() - env.BACKUP_DAYS * 86400 * 1000;
  for (const d of await fsp.readdir(env.BACKUPS_DIR).catch(() => [])) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Date.parse(d) < limit) {
      await fsp.rm(path.join(env.BACKUPS_DIR, d), { recursive: true, force: true });
    }
  }
}

async function lastBackup() {
  const days = (await fsp.readdir(env.BACKUPS_DIR).catch(() => [])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return days.length ? days[days.length - 1] : null;
}

// ── Démarrage / arrêt ────────────────────────────────────────────────────────
function init() {
  fs.mkdirSync(env.DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(env.UPLOADS_DIR, { recursive: true });
  articlesDoc.load();
  if (!Array.isArray(articlesDoc.data)) articlesDoc.data = [];
  membersDoc.load();
  if (!Array.isArray(membersDoc.data)) membersDoc.data = [];
  messagesDoc.load();
  if (!Array.isArray(messagesDoc.data)) messagesDoc.data = [];
  reindex();
  if (migrate()) articlesDoc.save(0);
  reindex();
  if (membersDoc.dirty) membersDoc.save(0);
  const run = () => { purgeTrash(); dailyBackup().catch((e) => console.error('[sauvegarde]', e.message)); };
  run();
  setInterval(run, 6 * 3600 * 1000).unref();
}

function flushAll() {
  return Promise.all([articlesDoc.flush(), membersDoc.flush(), messagesDoc.flush()]);
}

module.exports = {
  JsonDoc, writeAtomic, httpError,
  init, flushAll, lastBackup,
  publicArticles, getArticle, isPublic, summary, full, adminList,
  saveArticle, trashArticle, restoreArticle, destroyArticle, countView,
  listMembers, saveMember, deleteMember,
  addMessage, listMessages, unreadMessages, setMessageRead, deleteMessage,
  saveUpload, listUploads, deleteUpload, uploadPath,
  get version() { return version; },
};
