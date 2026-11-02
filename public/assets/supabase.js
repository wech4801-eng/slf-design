/**
 * ASLF — Accès à la base de données Supabase.
 *
 * Utilisé quand le site est hébergé sur GitHub Pages (pages fixes, sans serveur) :
 * les articles, photos, membres et messages sont alors stockés dans Supabase.
 * Sur un serveur Node (VPS), ce fichier reste inactif et l'API du serveur est utilisée.
 *
 * Sécurité : la clé ci-dessous est la clé publique du projet. Les droits sont
 * contrôlés dans la base (Row Level Security) : le public ne lit que les articles
 * publiés et peut seulement envoyer un message ; seul le compte administrateur écrit.
 */
(function () {
  'use strict';

  const CONFIG = {
    url: 'https://lyrvgjozkxexincjooki.supabase.co',
    key: 'sb_publishable_GwX_1_-Czae8lnfScnOYiA_-VGTZ1Ub',
    adminEmail: 'admin@aslf-france.org',
    bucket: 'photos',
  };

  // Actif sur GitHub Pages ; « ?base=supabase » permet de le tester ailleurs
  let forced = false;
  try {
    const p = new URLSearchParams(location.search).get('base');
    if (p === 'supabase') sessionStorage.setItem('aslf_base', 'supabase');
    if (p === 'serveur') sessionStorage.removeItem('aslf_base');
    forced = sessionStorage.getItem('aslf_base') === 'supabase';
  } catch {}
  const ACTIVE = /\.github\.io$/i.test(location.hostname) || forced;
  const BASE = /\.github\.io$/i.test(location.hostname) ? '/' + location.pathname.split('/')[1] : '';

  class DbError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  // ── Session de l'administrateur ───────────────────────────────────────────
  const SESSION_KEY = 'aslf_session_supabase';
  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  }
  function writeSession(s) {
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at }));
      else localStorage.removeItem(SESSION_KEY);
    } catch {}
  }

  async function authRequest(path, body, token) {
    let res;
    try {
      res = await fetch(CONFIG.url + '/auth/v1/' + path, {
        method: path === 'user' ? 'PUT' : 'POST',
        headers: { apikey: CONFIG.key, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body),
      });
    } catch { throw new DbError('Impossible de joindre le site. Vérifiez votre connexion internet, puis réessayez.', 0); }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function signIn(password) {
    const r = await authRequest('token?grant_type=password', { email: CONFIG.adminEmail, password });
    if (!r.ok) {
      if (r.status === 429) throw new DbError('Trop d’essais. Patientez quelques minutes avant de réessayer.', 429);
      throw new DbError('Mot de passe incorrect. Vérifiez les majuscules et réessayez.', 401);
    }
    writeSession(r.data);
    return r.data;
  }

  let refreshing = null;
  async function token() {
    const s = readSession();
    if (!s) return null;
    if (s.expires_at && s.expires_at * 1000 - Date.now() > 60 * 1000) return s.access_token;
    if (!refreshing) {
      refreshing = authRequest('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
        .then((r) => { if (!r.ok) { writeSession(null); return null; } writeSession(r.data); return r.data.access_token; })
        .catch(() => s.access_token)
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // ── Requêtes vers la base ─────────────────────────────────────────────────
  async function rest(method, path, body, { admin = false, prefer = '' } = {}) {
    const headers = { apikey: CONFIG.key };
    if (admin) {
      const t = await token();
      if (!t) throw new DbError('Votre session a expiré : reconnectez-vous.', 401);
      headers.Authorization = 'Bearer ' + t;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    let res;
    try {
      res = await fetch(CONFIG.url + '/rest/v1/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new DbError('Impossible de joindre le site. Vérifiez votre connexion internet, puis réessayez.', 0); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (res.status === 401 || (res.status === 403 && admin)) { writeSession(null); throw new DbError('Votre session a expiré : reconnectez-vous.', 401); }
    if (!res.ok) {
      const msg = data && data.message ? data.message : '';
      if (/email/.test(msg)) throw new DbError('Indiquez une adresse e-mail valide.', 400);
      throw new DbError('Une erreur est survenue. Réessayez dans un instant.', res.status);
    }
    return data;
  }

  // ── Articles ──────────────────────────────────────────────────────────────
  const LIST_FIELDS = 'id,slug,title,chapeau,coverImage,coverThumb,coverAlt,section,sectionLabel,sectionPage,categoryKey,categoryLabel,tone,author,status,publishAt,publishedAt,createdAt,updatedAt,deletedAt,readMinutes,views';
  const nowIso = () => new Date().toISOString();
  const articleDate = (a) => (a.status === 'planifié' && a.publishAt) || a.publishedAt || a.createdAt || a.updatedAt;
  function isPublic(a) {
    if (!a || a.deletedAt) return false;
    if (a.status === 'publié') return true;
    return a.status === 'planifié' && !!a.publishAt && Date.parse(a.publishAt) <= Date.now();
  }
  function decorate(a, admin) {
    const out = { ...a, date: articleDate(a), coverThumb: a.coverThumb || a.coverImage || '', categoryLabel: a.categoryLabel || a.sectionLabel };
    if (admin) out.isPublic = isPublic(a);
    return out;
  }
  const byDate = (x, y) => Date.parse(y.date) - Date.parse(x.date);

  async function publicArticles({ section = '' } = {}) {
    const filter = section ? '&section=eq.' + encodeURIComponent(section) : '';
    const rows = await rest('GET', `articles?select=${LIST_FIELDS}${filter}&order=publishedAt.desc.nullslast`);
    return rows.map((a) => decorate(a, false)).sort(byDate);
  }
  async function publicArticle(idOrSlug) {
    const v = encodeURIComponent(idOrSlug);
    const rows = await rest('GET', `articles?select=*&or=(id.eq.${v},slug.eq.${v})&limit=1`);
    if (!rows.length) return null;
    const a = decorate(rows[0], false);
    const related = (await rest('GET', `articles?select=${LIST_FIELDS}&section=eq.${encodeURIComponent(a.section)}&id=neq.${encodeURIComponent(a.id)}&order=publishedAt.desc.nullslast&limit=3`))
      .map((x) => decorate(x, false));
    return { article: a, related };
  }
  function countView(id) {
    const key = 'aslf_vue_' + id;
    try {
      const last = +localStorage.getItem(key) || 0;
      if (Date.now() - last < 6 * 3600 * 1000) return Promise.resolve(null);
      localStorage.setItem(key, String(Date.now()));
    } catch {}
    return rest('POST', 'rpc/increment_view', { article_id: id }).catch(() => null);
  }

  // Nettoyage d'un article avant enregistrement (mêmes règles que le serveur Node)
  const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
  const plain = (v, max) => window.SLFSanitize.toText(str(v, max * 2)).slice(0, max);
  const slugify = (s) => str(s, 200).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/['’]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
  const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
  function videoUrl(v) {
    const s = str(typeof v === 'string' ? v : v && v.url, 500);
    let m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,20})/i.exec(s);
    if (m) return { type: 'youtube', url: `https://www.youtube-nocookie.com/embed/${m[1]}` };
    m = /vimeo\.com\/(?:video\/)?(\d{4,12})/i.exec(s);
    if (m) return { type: 'vimeo', url: `https://player.vimeo.com/video/${m[1]}` };
    return null;
  }
  function imageUrl(v) {
    const u = window.SLFSanitize.safeUrl(str(v, 2000), 'src');
    if (!u) return '';
    return /^https?:/i.test(u) || u.startsWith('/') ? u : '/' + u.replace(/^\.\//, '');
  }

  async function uniqueSlug(base, id) {
    const root = base || 'article';
    const rows = await rest('GET', `articles?select=id,slug&slug=like.${encodeURIComponent(root)}*`, undefined, { admin: true });
    const taken = new Set(rows.filter((r) => r.id !== id).map((r) => r.slug));
    let slug = root;
    for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
    return slug;
  }

  async function normalizeArticle(input, existing) {
    const CFG = window.SLFConfig;
    const SAN = window.SLFSanitize;
    let status = ['publié', 'brouillon', 'planifié'].includes(input.status) ? input.status : 'brouillon';
    const content = SAN.sanitize(input.content || '');
    const title = plain(input.title, 200) || 'Sans titre';
    const id = existing ? existing.id : newId('art');
    const publishAt = status === 'planifié' && Date.parse(input.publishAt) ? new Date(input.publishAt).toISOString() : null;
    if (status === 'planifié' && !publishAt) status = 'brouillon';
    const section = CFG.section(input.section);
    const category = CFG.category(input.categoryKey);
    const coverImage = imageUrl(input.coverImage);
    const chapeau = plain(input.chapeau, 600);
    const words = SAN.toText(content).split(' ').filter(Boolean).length;
    const a = {
      id,
      slug: await uniqueSlug(slugify(input.slug) || slugify(title), id),
      title, chapeau, content,
      coverImage,
      coverThumb: coverImage ? imageUrl(input.coverThumb) : '',
      coverAlt: plain(input.coverAlt, 200),
      section: section.key, sectionLabel: section.label, sectionPage: section.page,
      categoryKey: category ? category.key : '', categoryLabel: category ? category.label : section.label, tone: category ? category.tone : 'actions',
      tags: (Array.isArray(input.tags) ? input.tags : []).map((t) => str(t, 40)).filter(Boolean).slice(0, 12),
      author: str(input.author, 80) || 'Rédaction ASLF',
      status, publishAt,
      seoTitle: plain(input.seoTitle, 80), metaDesc: plain(input.metaDesc, 220),
      gallery: (Array.isArray(input.gallery) ? input.gallery : []).map(imageUrl).filter(Boolean).slice(0, 80),
      videos: (Array.isArray(input.videos) ? input.videos : []).map(videoUrl).filter(Boolean).slice(0, 10),
      words,
      readMinutes: Math.max(1, Math.round((words + chapeau.split(' ').filter(Boolean).length) / 200)),
      updatedAt: nowIso(),
      publishedAt: existing ? existing.publishedAt || null : null,
    };
    if (a.status === 'publié' && !a.publishedAt) a.publishedAt = a.updatedAt;
    if (!existing) a.createdAt = a.updatedAt;
    return a;
  }

  async function getAdminArticle(id) {
    const rows = await rest('GET', `articles?select=*&id=eq.${encodeURIComponent(id)}`, undefined, { admin: true });
    if (!rows.length) throw new DbError('Article introuvable.', 404);
    return rows[0];
  }

  // ── Photos ────────────────────────────────────────────────────────────────
  const publicPhotoUrl = (path) => `${CONFIG.url}/storage/v1/object/public/${CONFIG.bucket}/${path}`;
  const photoPath = (url) => {
    const prefix = `${CONFIG.url}/storage/v1/object/public/${CONFIG.bucket}/`;
    return typeof url === 'string' && url.startsWith(prefix) ? url.slice(prefix.length) : null;
  };

  async function storage(method, path, body, contentType) {
    const t = await token();
    if (!t) throw new DbError('Votre session a expiré : reconnectez-vous.', 401);
    let res;
    try {
      res = await fetch(`${CONFIG.url}/storage/v1/${path}`, {
        method,
        headers: { apikey: CONFIG.key, Authorization: 'Bearer ' + t, ...(contentType ? { 'Content-Type': contentType } : {}) },
        body,
      });
    } catch { throw new DbError('Impossible de joindre le site. Vérifiez votre connexion internet, puis réessayez.', 0); }
    const data = await res.json().catch(() => null);
    if (res.status === 401) { writeSession(null); throw new DbError('Votre session a expiré : reconnectez-vous.', 401); }
    if (!res.ok) throw new DbError(res.status === 413 ? 'Photo trop lourde (10 Mo maximum).' : 'L’envoi de la photo a échoué. Réessayez.', res.status);
    return data;
  }

  async function uploadPhoto(blob) {
    const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' }[blob.type];
    if (!ext) throw new DbError('Ce fichier n’est pas une photo (JPG, PNG, WebP ou GIF).', 415);
    const d = new Date();
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, '0')).join('');
    const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${rand}.${ext}`;
    await storage('POST', `object/${CONFIG.bucket}/${path}`, blob, blob.type);
    return { url: publicPhotoUrl(path), size: blob.size };
  }

  function listFolder(prefix) {
    return storage('POST', `object/list/${CONFIG.bucket}`, JSON.stringify({ prefix, limit: 1000, sortBy: { column: 'name', order: 'desc' } }), 'application/json');
  }

  async function listPhotos() {
    const articles = await rest('GET', 'articles?select=id,title,coverImage,coverThumb,gallery,content,deletedAt', undefined, { admin: true });
    const used = (url) => articles.filter((a) => a.coverImage === url || a.coverThumb === url ||
      (a.gallery || []).includes(url) || (a.content || '').includes(url)).map((a) => ({ id: a.id, title: a.title, deleted: !!a.deletedAt }));
    const out = [];
    for (const year of (await listFolder('')) || []) {
      if (year.id) continue;
      for (const month of (await listFolder(year.name + '/')) || []) {
        if (month.id) continue;
        for (const f of (await listFolder(`${year.name}/${month.name}/`)) || []) {
          if (!f.id) continue;
          const url = publicPhotoUrl(`${year.name}/${month.name}/${f.name}`);
          out.push({ url, size: (f.metadata && f.metadata.size) || 0, date: f.created_at, usedBy: used(url) });
        }
      }
    }
    return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  // ── Membres et messages ───────────────────────────────────────────────────
  const MEMBER_FIELDS = { prenom: 80, nom: 80, email: 160, telephone: 40, ville: 80, statut: 40, cotisation: 40, adhesion: 10, notes: 2000 };
  function normalizeMember(input) {
    const m = {};
    for (const [k, max] of Object.entries(MEMBER_FIELDS)) m[k] = str(input[k], max);
    if (!m.prenom && !m.nom) throw new DbError('Indiquez au moins un nom ou un prénom.', 400);
    if (m.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) throw new DbError('Cette adresse e-mail ne semble pas correcte.', 400);
    if (m.adhesion && !/^\d{4}-\d{2}-\d{2}$/.test(m.adhesion)) m.adhesion = '';
    m.updatedAt = nowIso();
    return m;
  }
  const SUBJECTS = {
    adhesion: 'Adhésion', don: 'Don', benevole: 'Bénévolat', projet: 'Projet', presse: 'Presse',
    partenariat: 'Partenariat', information: 'Demande d’information', autre: 'Autre',
  };

  async function sendMessage(input) {
    const m = {
      nom: str(input.nom, 120), email: str(input.email, 160), telephone: str(input.telephone, 40),
      sujet: SUBJECTS[input.sujet] ? input.sujet : 'autre', message: str(input.message, 5000),
    };
    if (!m.nom) throw new DbError('Indiquez votre nom.', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) throw new DbError('Indiquez une adresse e-mail valide pour que nous puissions vous répondre.', 400);
    if (m.message.length < 2) throw new DbError('Écrivez votre message.', 400);
    await rest('POST', 'messages', m, { prefer: 'return=minimal' });
  }

  // ── Même interface que l'API du serveur Node (utilisée par l'administration) ──
  async function api(method, url, body) {
    const u = new URL(url, location.origin);
    const p = u.pathname.replace(/^.*\/api\//, '/api/');
    const q = u.searchParams;
    const enc = encodeURIComponent;
    let m;

    if (p === '/api/login') { await signIn(String((body && body.password) || '')); return { ok: true }; }
    if (p === '/api/logout') { writeSession(null); return { ok: true }; }
    if (p === '/api/session') return { connected: !!(await token()) };

    if (p === '/api/admin/articles' && method === 'GET') {
      const rows = await rest('GET', `articles?select=${LIST_FIELDS}&order=updatedAt.desc`, undefined, { admin: true });
      return rows.map((a) => decorate(a, true));
    }
    if (p === '/api/admin/articles' && method === 'POST') {
      const a = await normalizeArticle(body || {}, null);
      const rows = await rest('POST', 'articles', a, { admin: true, prefer: 'return=representation' });
      return decorate(rows[0], true);
    }
    if ((m = /^\/api\/admin\/articles\/([\w-]+)(\/restaurer)?$/.exec(p))) {
      const id = m[1];
      if (m[2]) { await rest('PATCH', `articles?id=eq.${enc(id)}`, { deletedAt: null }, { admin: true }); return { ok: true }; }
      if (method === 'GET') return decorate(await getAdminArticle(id), true);
      if (method === 'PUT') {
        const existing = await getAdminArticle(id);
        const a = await normalizeArticle(body || {}, existing);
        const rows = await rest('PATCH', `articles?id=eq.${enc(id)}`, a, { admin: true, prefer: 'return=representation' });
        return decorate(rows[0], true);
      }
      if (method === 'DELETE') {
        if (q.get('definitif') === '1') await rest('DELETE', `articles?id=eq.${enc(id)}`, undefined, { admin: true });
        else await rest('PATCH', `articles?id=eq.${enc(id)}`, { deletedAt: nowIso() }, { admin: true });
        return { ok: true };
      }
    }

    if (p === '/api/admin/photos' && method === 'POST') return uploadPhoto(body);
    if (p === '/api/admin/photos' && method === 'GET') return listPhotos();
    if (p === '/api/admin/photos' && method === 'DELETE') {
      const url = q.get('url') || '';
      const path = photoPath(url);
      if (!path) throw new DbError('Photo inconnue.', 400);
      const ph = (await listPhotos()).find((x) => x.url === url);
      if (ph && ph.usedBy.length) throw new DbError('Cette photo est utilisée dans un article : retirez-la de l’article d’abord.', 409);
      await storage('DELETE', `object/${CONFIG.bucket}`, JSON.stringify({ prefixes: [path] }), 'application/json');
      return { ok: true };
    }

    if (p === '/api/admin/membres' && method === 'GET') return rest('GET', 'members?select=*&order=nom.asc,prenom.asc', undefined, { admin: true });
    if (p === '/api/admin/membres' && method === 'POST') {
      const rows = await rest('POST', 'members', { id: newId('mbr'), ...normalizeMember(body || {}) }, { admin: true, prefer: 'return=representation' });
      return rows[0];
    }
    if ((m = /^\/api\/admin\/membres\/([\w-]+)$/.exec(p))) {
      if (method === 'PUT') return (await rest('PATCH', `members?id=eq.${enc(m[1])}`, normalizeMember(body || {}), { admin: true, prefer: 'return=representation' }))[0];
      if (method === 'DELETE') { await rest('DELETE', `members?id=eq.${enc(m[1])}`, undefined, { admin: true }); return { ok: true }; }
    }

    if (p === '/api/admin/messages' && method === 'GET') {
      const rows = await rest('GET', 'messages?select=*&order=createdAt.desc', undefined, { admin: true });
      return rows.map((x) => ({ ...x, sujetLabel: SUBJECTS[x.sujet] || 'Autre' }));
    }
    if ((m = /^\/api\/admin\/messages\/([\w-]+)$/.exec(p))) {
      if (method === 'PUT') { await rest('PATCH', `messages?id=eq.${enc(m[1])}`, { lu: !!(body && body.lu) }, { admin: true }); return { ok: true }; }
      if (method === 'DELETE') { await rest('DELETE', `messages?id=eq.${enc(m[1])}`, undefined, { admin: true }); return { ok: true }; }
    }

    if (p === '/api/admin/mot-de-passe') {
      const next = String((body && body.next) || '');
      if (next.length < 10) throw new DbError('Le mot de passe doit faire au moins 10 caractères.', 400);
      try { await signIn(String((body && body.current) || '')); }
      catch (e) { if (e.status === 401) throw new DbError('Le mot de passe actuel est incorrect.', 400); throw e; }
      const r = await authRequest('user', { password: next }, await token());
      if (!r.ok) throw new DbError(r.status === 422 ? 'Choisissez un mot de passe différent de l’actuel.' : 'Le changement a échoué. Réessayez.', r.status);
      return { ok: true };
    }

    if (p === '/api/admin/etat') {
      const [arts, members, messages, photos] = await Promise.all([
        rest('GET', `articles?select=${LIST_FIELDS}`, undefined, { admin: true }),
        rest('GET', 'members?select=id', undefined, { admin: true }),
        rest('GET', 'messages?select=id,lu', undefined, { admin: true }),
        listPhotos().catch(() => []),
      ]);
      const list = arts.map((a) => decorate(a, true));
      return {
        version: '2.0.0 (GitHub + Supabase)',
        articles: {
          enLigne: list.filter((a) => a.isPublic).length,
          brouillons: list.filter((a) => !a.isPublic && !a.deletedAt).length,
          corbeille: list.filter((a) => a.deletedAt).length,
        },
        membres: members.length,
        messagesNonLus: messages.filter((x) => !x.lu).length,
        photos: { nombre: photos.length, poids: photos.reduce((n, x) => n + x.size, 0) },
        disqueLibre: null,
        derniereSauvegarde: null,
        demarrage: null,
      };
    }

    if (p === '/api/admin/sauvegarde') {
      const [articles, members, messages] = await Promise.all([
        rest('GET', 'articles?select=*', undefined, { admin: true }),
        rest('GET', 'members?select=*', undefined, { admin: true }),
        rest('GET', 'messages?select=*', undefined, { admin: true }),
      ]);
      return new Blob([JSON.stringify({ date: nowIso(), articles, members, messages }, null, 2)], { type: 'application/json' });
    }

    throw new DbError('Action inconnue.', 404);
  }

  window.SLFSupabase = { ACTIVE, BASE, api, signIn, token, publicArticles, publicArticle, countView, sendMessage, DbError };
})();
