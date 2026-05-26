/**
 * SLF Admin Auth — client-side authentication helper.
 *
 * ⚠️  Note importante de sécurité ⚠️
 *  Ce site est entièrement statique : il n'existe aucun serveur pour vérifier
 *  les identifiants. Toute authentification côté navigateur peut être contournée
 *  par un utilisateur déterminé (DevTools / localStorage). Cette implémentation
 *  ajoute des garde-fous (hash SHA-256, jeton de session daté, expiration)
 *  mais ne remplace pas une authentification serveur.
 *
 *  Pour une vraie sécurité, déployer un backend (Netlify Functions, Cloudflare
 *  Workers, etc.) qui valide les identifiants et émet un JWT signé.
 */
(function (global) {
  'use strict';

  // SHA-256 du mot de passe admin attendu. Calculé en avance :
  //   await sha256('WqTC^+3wjc*v3#Qnbp')
  const EXPECTED_USER     = 'admin';
  const EXPECTED_PASS_HASH = '012798d1171df5c8c6d7ecf2abb30adfe490d91ea5a029286bbcc67c3bf9b722';

  // Durée de validité du jeton de session : 8 heures.
  const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
  const STORAGE_KEY = 'slf_admin_session';

  // ── Helpers crypto ─────────────────────────────────────────────────────────
  async function sha256(text) {
    const enc  = new TextEncoder().encode(text);
    const buf  = await crypto.subtle.digest('SHA-256', enc);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // ── Session helpers ────────────────────────────────────────────────────────
  function readSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.token || !data.exp) return null;
      if (Date.now() > data.exp) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  function writeSession() {
    // Génère un jeton imprévisible
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
    const data = { token, exp: Date.now() + SESSION_DURATION_MS, user: EXPECTED_USER };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return data;
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
    // Compatibilité avec l'ancienne clé
    localStorage.removeItem('slf_admin_auth');
  }

  function isAuthenticated() {
    return !!readSession();
  }

  async function login(username, password) {
    if ((username || '').trim() !== EXPECTED_USER) return false;
    const hash = await sha256(password || '');
    if (hash !== EXPECTED_PASS_HASH) return false;
    writeSession();
    return true;
  }

  function logout(redirect = 'admin-login.html') {
    clearSession();
    // Aussi nettoyer le token API et le mot de passe mémorisés (si présents)
    try {
      localStorage.removeItem('slf_admin_token');
      localStorage.removeItem('slf_admin_pwd');
    } catch {}
    window.location.href = redirect;
  }

  /**
   * À appeler en haut des pages admin protégées. Redirige vers la page de
   * connexion si la session est absente ou expirée.
   */
  function requireAuth(loginPage = 'admin-login.html') {
    if (!isAuthenticated()) {
      window.location.replace(loginPage);
      return false;
    }
    return true;
  }

  // Migration : si l'ancienne clé existe, on bascule en session datée
  if (localStorage.getItem('slf_admin_auth') && !localStorage.getItem(STORAGE_KEY)) {
    writeSession();
    localStorage.removeItem('slf_admin_auth');
  }

  global.SLFAuth = {
    isAuthenticated,
    login,
    logout,
    requireAuth,
    sha256,        // exposé pour debug / outillage
  };
})(window);
