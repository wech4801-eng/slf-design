/**
 * ASLF DB — Couche d'abstraction pour articles & membres.
 *
 * Backend : API REST du serveur Node.js auto-hébergé (server.js).
 * Temps réel : SSE via /api/stream (notifie tous les clients quand
 * un article est créé/modifié/supprimé → re-fetch automatique).
 *
 * Fallback : si l'API n'est pas joignable (mode dev sans serveur Node),
 * retombe automatiquement sur localStorage.
 *
 * API publique (toutes les méthodes async) :
 *   SLFDB.getArticles()
 *   SLFDB.getArticle(id)
 *   SLFDB.saveArticle(article)         (nécessite SLFDB.adminToken)
 *   SLFDB.deleteArticle(id)            (nécessite SLFDB.adminToken)
 *   SLFDB.incrementViews(id)
 *   SLFDB.getMembers()                 (admin)
 *   SLFDB.saveMember(member)           (admin)
 *   SLFDB.deleteMember(id)             (admin)
 *   SLFDB.onArticlesChange(callback)   → unsubscribe()
 *   SLFDB.onMembersChange(callback)    → unsubscribe()
 *
 * Authentification admin :
 *   SLFDB.login(password) → bool       (stocke le token)
 *   SLFDB.logout()
 *   SLFDB.isAdmin()
 */
(function (global) {
  'use strict';

  const API       = '/api';
  const TOKEN_KEY = 'slf_admin_token';
  const PWD_KEY   = 'slf_admin_pwd'; // mémorisé localement pour éviter
                                      // les re-prompts mot de passe

  let backend = 'api'; // sera 'localStorage' si l'API ne répond pas

  // ── Token admin (en localStorage pour persister entre pages) ──────────────
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch {}
  }

  // ── Helpers fetch ─────────────────────────────────────────────────────────
  function authHeaders() {
    const t = getToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  async function fetchJson(url, opts = {}, isRetry = false) {
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('application/json') ? await res.json() : await res.text();

    // Auto-relogin SILENCIEUX sur 401 (sans demander le mot de passe à l'utilisateur)
    // Utilise le mot de passe mémorisé à la connexion initiale
    if (res.status === 401 && !isRetry && opts.method && opts.method !== 'GET') {
      const reAuthed = await silentReauth();
      if (reAuthed) {
        return fetchJson(url, {
          ...opts,
          headers: { ...(opts.headers || {}), ...authHeaders() },
        }, true);
      }
    }

    if (!res.ok) {
      const err = new Error(body?.error || res.statusText);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // Re-authentification silencieuse : utilise le mot de passe mémorisé.
  // Si pas de mot de passe stocké → renvoie false (l'appelant gère l'erreur).
  let silentReauthPromise = null;
  function silentReauth() {
    if (silentReauthPromise) return silentReauthPromise;
    silentReauthPromise = (async () => {
      try {
        const pwd = localStorage.getItem(PWD_KEY);
        if (!pwd) return false;
        return await login(pwd);
      } finally {
        silentReauthPromise = null;
      }
    })();
    return silentReauthPromise;
  }

  // ── Détection backend (1 ping API au démarrage) ────────────────────────────
  let apiReady = null;
  async function detectBackend() {
    if (apiReady !== null) return apiReady;
    // Optimisation : sur GitHub Pages, on sait qu'il n'y a pas d'API → skip le ping
    const isGithubPages = /\.github\.io$/i.test(location.hostname);
    if (isGithubPages) {
      apiReady = false;
      backend = 'localStorage';
      console.info('[SLFDB] GitHub Pages détecté → mode démo (localStorage)');
      if (location.pathname.includes('admin-')) showDemoBanner();
      return false;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      await fetch(API + '/articles', { signal: ctrl.signal });
      clearTimeout(timer);
      apiReady = true;
      backend = 'api';
    } catch {
      apiReady = false;
      backend = 'localStorage';
      console.warn('[SLFDB] API injoignable → fallback localStorage (mono-appareil)');
      if (location.pathname.includes('admin-')) showDemoBanner();
    }
    return apiReady;
  }

  // Bannière "mode démo" affichée si l'API n'est pas disponible
  // (typique d'un hébergement GitHub Pages).
  function showDemoBanner() {
    if (document.getElementById('__slfDemoBanner')) return;
    const wait = () => {
      if (!document.body) return setTimeout(wait, 50);
      const b = document.createElement('div');
      b.id = '__slfDemoBanner';
      b.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#fef3c7;color:#92400e;font-family:Inter,sans-serif;font-size:12px;padding:8px 16px;text-align:center;z-index:999;border-top:1px solid #fde68a;box-shadow:0 -2px 8px rgba(0,0,0,.05);';
      b.innerHTML = '⚠️ <strong>Mode démo</strong> — pas de serveur disponible. Les articles que vous créez sont stockés uniquement dans <em>ce navigateur</em>. Pour une vraie mise en production, utilisez Hostinger (voir HOSTINGER.md).';
      document.body.appendChild(b);
    };
    wait();
  }

  // ── Stockage local (fallback uniquement) ──────────────────────────────────
  function lsGet(key) {
    try { const r = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(r) ? r : []; }
    catch { return []; }
  }
  function lsSet(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); return true; }
    catch (e) { console.error('localStorage saturé:', e); return false; }
  }

  // ── Migrations de schéma article ──────────────────────────────────────────
  // Les images du livret ont été converties PNG → WebP (gain -89 %).
  // Pour les utilisateurs avec un ancien localStorage / d'anciens articles
  // référençant encore "livret/N.png", on réécrit à la volée vers ".webp".
  // Sans effet si l'article est déjà à jour.
  //
  // Important : on évite les regex globales stateful (lastIndex interfère
  // avec replace) en créant la regex à l'appel ou en utilisant un literal
  // non-cached.
  function migrateLivretUrl(s) {
    if (typeof s !== 'string' || s.indexOf('livret/') === -1) return s;
    return s.replace(/(images\/livret\/\d+)\.png/g, '$1.webp');
  }
  function migrateArticle(a) {
    if (!a || typeof a !== 'object') return a;
    const newCover = migrateLivretUrl(a.coverImage);
    if (newCover !== a.coverImage) { a.coverImage = newCover; a.__migrated = true; }
    const newContent = migrateLivretUrl(a.content);
    if (newContent !== a.content) { a.content = newContent; a.__migrated = true; }
    return a;
  }
  function migrateArticles(arr) {
    if (!Array.isArray(arr)) return arr;
    let anyChanged = false;
    arr.forEach(a => {
      const wasMig = !!a.__migrated;
      migrateArticle(a);
      if (a.__migrated && !wasMig) anyChanged = true;
    });
    // Persister le résultat migré pour éviter de refaire le travail à chaque lecture
    if (anyChanged) {
      try { lsSet('slf_articles', arr); } catch {}
    }
    return arr;
  }

  // ── Seed initial : si localStorage est vide en mode démo, charge seed-articles.json
  let seedAttempted = false;
  async function maybeSeedFromFile() {
    if (seedAttempted) return;
    seedAttempted = true;
    const existing = lsGet('slf_articles');
    if (existing.length > 0) return;
    try {
      const r = await fetch('seed-articles.json', { cache: 'no-cache' });
      if (!r.ok) return;
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        lsSet('slf_articles', arr);
        console.info('[SLFDB] ' + arr.length + ' articles chargés depuis seed-articles.json');
      }
    } catch {}
  }

  // ── Articles ──────────────────────────────────────────────────────────────
  async function getArticles() {
    if (await detectBackend()) {
      const arr = await fetchJson(API + '/articles');
      return Array.isArray(arr) ? arr.map(migrateArticle) : arr;
    }
    await maybeSeedFromFile();
    return migrateArticles(lsGet('slf_articles'));
  }
  async function getArticle(id) {
    if (!id) return null;
    if (await detectBackend()) {
      try {
        const a = await fetchJson(API + '/articles/' + encodeURIComponent(id));
        return migrateArticle(a);
      }
      catch (e) { if (e.status === 404) return null; throw e; }
    }
    const arr = migrateArticles(lsGet('slf_articles'));
    return arr.find(a => a.id === id) || null;
  }
  async function saveArticle(article) {
    if (!article || !article.id) throw new Error('article.id requis');
    if (await detectBackend()) {
      return fetchJson(API + '/articles', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(article),
      });
    }
    const arts = lsGet('slf_articles');
    const idx = arts.findIndex(a => a.id === article.id);
    if (idx === -1) arts.unshift(article); else arts[idx] = article;
    lsSet('slf_articles', arts);
    return article;
  }
  async function deleteArticle(id) {
    if (await detectBackend()) {
      return fetchJson(API + '/articles/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: authHeaders(),
      });
    }
    return lsSet('slf_articles', lsGet('slf_articles').filter(a => a.id !== id));
  }
  async function incrementViews(id) {
    if (await detectBackend()) {
      try { await fetchJson(API + '/articles/' + encodeURIComponent(id) + '/view', { method: 'POST' }); }
      catch {}
      return;
    }
    const arts = lsGet('slf_articles');
    const a = arts.find(x => x.id === id);
    if (a) { a.views = (a.views || 0) + 1; lsSet('slf_articles', arts); }
  }

  // ── Membres ──────────────────────────────────────────────────────────────
  async function getMembers() {
    if (await detectBackend()) {
      try { return await fetchJson(API + '/members', { headers: authHeaders() }); }
      catch (e) { if (e.status === 401) return []; throw e; }
    }
    return lsGet('slf_members');
  }
  async function saveMember(m) {
    if (!m || !m.id) throw new Error('member.id requis');
    if (await detectBackend()) {
      return fetchJson(API + '/members', { method: 'PUT', headers: authHeaders(), body: JSON.stringify(m) });
    }
    const mems = lsGet('slf_members');
    const idx = mems.findIndex(x => x.id === m.id);
    if (idx === -1) mems.unshift(m); else mems[idx] = m;
    lsSet('slf_members', mems);
    return m;
  }
  async function deleteMember(id) {
    if (await detectBackend()) {
      return fetchJson(API + '/members/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
    }
    return lsSet('slf_members', lsGet('slf_members').filter(m => m.id !== id));
  }

  // ── Authentification ────────────────────────────────────────────────────
  async function login(password) {
    if (!(await detectBackend())) {
      // Mode localStorage : on n'a pas d'API à interroger, on retourne true
      // (l'authentification est gérée par SLFAuth côté client)
      try { localStorage.setItem(PWD_KEY, password); } catch {}
      return true;
    }
    try {
      const res = await fetchJson(API + '/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (res && res.token) {
        setToken(res.token);
        // Mémoriser le mot de passe pour les re-auth silencieuses
        try { localStorage.setItem(PWD_KEY, password); } catch {}
        return true;
      }
      return false;
    } catch { return false; }
  }
  function logout() {
    setToken(null);
    try { localStorage.removeItem(PWD_KEY); } catch {}
  }
  function isAdmin() { return !!getToken(); }

  // ── Temps réel : SSE + fallback polling (compatible Hostinger) ─────────
  let evtSource = null;
  let pollTimer = null;
  let lastChange = 0;
  let articlesSubs = new Set();
  let membersSubs  = new Set();

  function notifyArticles() {
    articlesSubs.forEach(cb => { getArticles().then(cb).catch(() => {}); });
  }
  function notifyMembers() {
    membersSubs.forEach(cb => { getMembers().then(cb).catch(() => {}); });
  }

  // Polling : interroge /api/changes toutes les 5 s et notifie si changement
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch(API + '/changes?since=' + lastChange);
        if (!r.ok) return;
        const j = await r.json();
        if (j.lastChange && j.lastChange > lastChange) {
          lastChange = j.lastChange;
          if (j.changed) { notifyArticles(); notifyMembers(); }
        }
      } catch {}
    }, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function ensureRealtime() {
    if (backend !== 'api') return;
    if (evtSource || pollTimer) return;
    // Tente SSE d'abord ; bascule en polling si erreur
    try {
      evtSource = new EventSource(API + '/stream');
      let gotMessage = false;
      evtSource.addEventListener('articles-updated', () => { gotMessage = true; notifyArticles(); });
      evtSource.addEventListener('members-updated',  () => { gotMessage = true; notifyMembers();  });
      evtSource.onerror = () => {
        // Si on n'a jamais rien reçu, fermer et basculer en polling
        if (!gotMessage) {
          try { evtSource.close(); } catch {}
          evtSource = null;
          console.info('[SLFDB] SSE indisponible (hébergement mutualisé ?) → polling 5 s');
          startPolling();
        }
        // Sinon : laisser le navigateur reconnecter tout seul
      };
    } catch {
      startPolling();
    }
  }

  function onArticlesChange(cb) {
    articlesSubs.add(cb);
    detectBackend().then(ok => {
      getArticles().then(cb).catch(() => cb([]));
      if (ok) ensureRealtime();
    });
    return () => articlesSubs.delete(cb);
  }
  function onMembersChange(cb) {
    membersSubs.add(cb);
    detectBackend().then(ok => {
      getMembers().then(cb).catch(() => cb([]));
      if (ok) ensureRealtime();
    });
    return () => membersSubs.delete(cb);
  }

  // ── Export ───────────────────────────────────────────────────────────────
  global.SLFDB = {
    get backend() { return backend; },
    getArticles, getArticle, saveArticle, deleteArticle, incrementViews,
    getMembers, saveMember, deleteMember,
    onArticlesChange, onMembersChange,
    login, logout, isAdmin,
  };
})(window);
