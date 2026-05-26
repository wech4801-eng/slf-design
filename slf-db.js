/**
 * SLF DB — Couche d'abstraction pour articles & membres.
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

  const API   = '/api';
  const TOKEN_KEY = 'slf_admin_token';

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

    // Auto-relogin sur 401 (token absent ou expiré)
    if (res.status === 401 && !isRetry && opts.method && opts.method !== 'GET') {
      const reAuthed = await promptReauth();
      if (reAuthed) {
        // Re-essayer avec le nouveau token
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

  // Modal de re-authentification (créée à la volée)
  let reauthPromise = null;
  function promptReauth() {
    // Évite plusieurs prompts simultanés
    if (reauthPromise) return reauthPromise;
    reauthPromise = new Promise((resolve) => {
      // Construit la modale en DOM
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:380px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.3);font-family:Inter,sans-serif;';
      box.innerHTML = `
        <h3 style="margin:0 0 8px;color:#006830;font-size:18px;font-family:'Playfair Display',serif;">🔒 Session expirée</h3>
        <p style="margin:0 0 16px;color:#6c757d;font-size:13px;line-height:1.5;">
          Pour des raisons de sécurité, votre session admin a expiré.
          Entrez votre mot de passe pour continuer sans perdre votre travail.
        </p>
        <input type="password" id="__slfReauthPwd" placeholder="Mot de passe admin"
               style="width:100%;padding:10px 12px;border:2px solid #e9ecef;border-radius:8px;font-size:14px;outline:none;margin-bottom:8px;" />
        <div id="__slfReauthErr" style="display:none;color:#CE1126;font-size:12px;margin-bottom:8px;">⚠️ Mot de passe incorrect</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="__slfReauthCancel" style="padding:9px 14px;background:#f1f3f5;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;">Annuler</button>
          <button id="__slfReauthOk"     style="padding:9px 18px;background:#00843D;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;">Confirmer</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const input = box.querySelector('#__slfReauthPwd');
      const err   = box.querySelector('#__slfReauthErr');
      const ok    = box.querySelector('#__slfReauthOk');
      const cancel= box.querySelector('#__slfReauthCancel');
      setTimeout(() => input.focus(), 50);

      const cleanup = (val) => {
        overlay.remove();
        reauthPromise = null;
        resolve(val);
      };
      ok.onclick = async () => {
        const pwd = input.value;
        if (!pwd) { input.focus(); return; }
        ok.disabled = true; ok.textContent = '…';
        const success = await login(pwd);
        if (success) cleanup(true);
        else {
          err.style.display = 'block';
          ok.disabled = false; ok.textContent = 'Confirmer';
          input.value = ''; input.focus();
        }
      };
      cancel.onclick = () => cleanup(false);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ok.click();
        if (e.key === 'Escape') cancel.click();
      });
    });
    return reauthPromise;
  }

  // ── Détection backend (1 ping API au démarrage) ────────────────────────────
  let apiReady = null;
  async function detectBackend() {
    if (apiReady !== null) return apiReady;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      await fetch(API + '/articles', { signal: ctrl.signal });
      clearTimeout(timer);
      apiReady = true;
      backend = 'api';
    } catch {
      apiReady = false;
      backend = 'localStorage';
      console.warn('[SLFDB] API injoignable → fallback localStorage (mono-appareil)');
    }
    return apiReady;
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

  // ── Articles ──────────────────────────────────────────────────────────────
  async function getArticles() {
    if (await detectBackend()) return fetchJson(API + '/articles');
    return lsGet('slf_articles');
  }
  async function getArticle(id) {
    if (!id) return null;
    if (await detectBackend()) {
      try { return await fetchJson(API + '/articles/' + encodeURIComponent(id)); }
      catch (e) { if (e.status === 404) return null; throw e; }
    }
    return lsGet('slf_articles').find(a => a.id === id) || null;
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
      // En mode localStorage on garde le système de jeton local d'admin-auth.js
      return false;
    }
    try {
      const res = await fetchJson(API + '/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      if (res && res.token) { setToken(res.token); return true; }
      return false;
    } catch { return false; }
  }
  function logout() { setToken(null); }
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
