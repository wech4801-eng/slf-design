/**
 * ASLF — Outils communs de l'espace de gestion :
 * en-tête et menu, appels au serveur, messages, fenêtres de confirmation, photos.
 */
(function () {
  'use strict';

  const ICONS = 'icons.svg';
  // Hébergement sans serveur (GitHub Pages) : les données passent par Supabase
  const DB = window.SLFSupabase && window.SLFSupabase.ACTIVE ? window.SLFSupabase : null;
  const BASE = DB ? DB.BASE : '';
  /** Adresse affichable d'une image du site (« /images/… » → sous-dossier GitHub si besoin). */
  const src = (u) => (u && u.startsWith('/') && !u.startsWith('//') ? BASE + u : u || '');
  const herePage = () => (location.pathname.split('/').pop() || '') + location.search;
  const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="${ICONS}#${name}"></use></svg>`;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ── En-tête, menu et barre du bas ─────────────────────────────────────────
  const NAV = [
    { key: 'articles', href: './', label: 'Articles', icon: 'file-text' },
    { key: 'messages', href: 'messages.html', label: 'Messages', icon: 'mail' },
    { key: 'membres', href: 'membres.html', label: 'Membres', icon: 'users' },
    { key: 'photos', href: 'photos.html', label: 'Photos', icon: 'image' },
    { key: 'reglages', href: 'reglages.html', label: 'Réglages', icon: 'settings' },
  ];

  function renderChrome() {
    const page = document.body.dataset.page;
    if (!page || page === 'connexion') return;
    const links = NAV.map((n) => `<a href="${n.href}"${n.key === page ? ' aria-current="page"' : ''}>${icon(n.icon)}<span>${n.label}</span></a>`).join('');
    const header = document.createElement('header');
    header.className = 'top';
    header.innerHTML = `
      <div class="flag" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="top-inner">
        <a class="brand" href="./">
          <img src="../images/logo-aslf-128.webp" alt="" width="44" height="44">
          <span><strong>ASLF</strong><small>Espace de gestion du site</small></span>
        </a>
        <nav class="nav" aria-label="Menu principal">${links}</nav>
        <div class="top-actions">
          <a class="link-btn" href="../" target="_blank" rel="noopener">${icon('external-link')}<span>Voir le site</span></a>
          <button class="link-btn hide-sm" type="button" data-logout>${icon('log-out')}<span>Se déconnecter</span></button>
        </div>
      </div>`;
    document.body.prepend(header);
    const tabbar = document.createElement('nav');
    tabbar.className = 'tabbar';
    tabbar.setAttribute('aria-label', 'Menu');
    tabbar.innerHTML = links;
    document.body.append(tabbar);
    header.querySelector('[data-logout]').addEventListener('click', logout);
    refreshUnread();
  }

  // Pastille du nombre de messages non lus dans le menu
  async function refreshUnread() {
    let n = 0;
    try { n = (await api('GET', '/api/admin/messages')).filter((m) => !m.lu).length; } catch { return; }
    document.querySelectorAll('a[href="messages.html"]').forEach((a) => {
      let b = a.querySelector('.badge');
      if (!n) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement('span'); b.className = 'badge'; a.append(b); }
      b.textContent = n;
      b.setAttribute('aria-label', n + ' non lu' + (n > 1 ? 's' : ''));
    });
  }

  async function logout() {
    try { await api('POST', '/api/logout'); } catch {}
    location.href = 'connexion.html';
  }

  // ── Appels au serveur ─────────────────────────────────────────────────────
  class ApiError extends Error {}

  async function api(method, url, body, opts = {}) {
    if (DB) {
      try { return await DB.api(method, url, body); }
      catch (e) {
        if (e.status === 401 && !url.endsWith('/api/login')) {
          location.href = 'connexion.html?suite=' + encodeURIComponent(herePage());
        }
        throw new ApiError(e.message || 'Une erreur est survenue. Réessayez dans un instant.');
      }
    }
    const headers = { 'X-Requested-With': 'ASLF' };
    let payload = body;
    if (body !== undefined && !(body instanceof Blob)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ApiError('Impossible de joindre le site. Vérifiez votre connexion internet, puis réessayez.');
    }
    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) data = await res.json().catch(() => null);
    if (res.status === 401 && !url.endsWith('/api/login')) {
      if (opts.onExpired) opts.onExpired();
      // Session expirée : on revient sur cette page après la reconnexion
      location.href = 'connexion.html?suite=' + encodeURIComponent(herePage());
      throw new ApiError('Votre session a expiré : reconnectez-vous.');
    }
    if (!res.ok) throw new ApiError((data && data.error) || 'Une erreur est survenue. Réessayez dans un instant.');
    return data;
  }

  // ── Messages éphémères ────────────────────────────────────────────────────
  function toast(message, type = 'ok') {
    let box = $('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.append(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = icon(type === 'error' ? 'triangle-alert' : 'circle-check') + '<span></span>';
    el.querySelector('span').textContent = message;
    box.append(el);
    setTimeout(() => el.remove(), type === 'error' ? 8000 : 4000);
  }

  // ── Fenêtre de confirmation ou de saisie ──────────────────────────────────
  /**
   * Renvoie une promesse : true/false pour une confirmation ; les valeurs saisies
   * (objet) si `fields` est fourni, ou null si la personne annule.
   */
  function dialog({ title, text = '', ok = 'Confirmer', cancel = 'Annuler', danger = false, fields = null, html = '' }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      const inputs = (fields || []).map((f, i) => `
        <label class="field"><span>${esc(f.label)}</span>
          <input class="input" name="${esc(f.name)}" type="${f.type || 'text'}" value="${esc(f.value || '')}"
            ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.required ? 'required' : ''} ${i === 0 ? 'autofocus' : ''}>
          ${f.hint ? `<small class="hint">${esc(f.hint)}</small>` : ''}
        </label>`).join('');
      d.innerHTML = `
        <form method="dialog">
          <div class="dlg-body">
            <h2>${esc(title)}</h2>
            ${text ? `<p>${esc(text)}</p>` : ''}${html}${inputs}
          </div>
          <div class="dlg-actions">
            ${cancel ? `<button class="btn btn-secondary" value="cancel" type="submit" formnovalidate>${esc(cancel)}</button>` : ''}
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok" type="submit">${esc(ok)}</button>
          </div>
        </form>`;
      document.body.append(d);
      const form = d.querySelector('form');
      d.addEventListener('close', () => {
        const confirmed = d.returnValue === 'ok';
        const result = fields ? (confirmed ? Object.fromEntries(new FormData(form)) : null) : confirmed;
        d.remove();
        resolve(result);
      });
      d.addEventListener('cancel', () => { d.returnValue = 'cancel'; });
      d.showModal();
      if (!fields) d.querySelector('.btn-primary, .btn-danger').focus();
    });
  }

  // ── Dates en français ─────────────────────────────────────────────────────
  function frDate(iso, withTime) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', ' h ');
    if (diff === 0) return withTime ? `aujourd’hui à ${time}` : 'aujourd’hui';
    if (diff === 1) return withTime ? `hier à ${time}` : 'hier';
    if (diff === -1) return withTime ? `demain à ${time}` : 'demain';
    const opts = { day: 'numeric', month: 'long' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return 'le ' + d.toLocaleDateString('fr-FR', opts) + (withTime ? ` à ${time}` : '');
  }

  // ── Photos : réduction dans le navigateur, puis envoi ─────────────────────
  // Une photo de téléphone (5 à 10 Mo) devient environ 250 Ko : envoi rapide, site léger.
  let webpSupport = null;
  function canWebp() {
    if (webpSupport === null) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      webpSupport = c.toDataURL('image/webp').startsWith('data:image/webp');
    }
    return webpSupport;
  }

  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('illisible')); };
      img.src = url;
    });
  }

  function encode(source, maxSide, quality) {
    const w0 = source.naturalWidth || source.width;
    const h0 = source.naturalHeight || source.height;
    const ratio = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * ratio));
    const h = Math.max(1, Math.round(h0 * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const type = canWebp() ? 'image/webp' : 'image/jpeg';
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('conversion'))), type, quality));
  }

  function checkImageFile(file) {
    if (!file) return 'Aucun fichier choisi.';
    if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
      return 'Cette photo d’iPhone (format « HEIC ») ne peut pas être lue ici. Sur l’iPhone : Réglages › Appareil photo › Formats › « Le plus compatible ».';
    }
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) return `« ${file.name} » n’est pas une photo (formats acceptés : JPG, PNG, WebP).`;
    if (file.size > 40 * 1024 * 1024) return `« ${file.name} » est trop lourde (plus de 40 Mo).`;
    return null;
  }

  /** Prépare et envoie une photo. Renvoie { url, thumb } (thumb : petite version pour les listes). */
  async function uploadPhoto(file, { maxSide = 1600, withThumb = false } = {}) {
    const problem = checkImageFile(file);
    if (problem) throw new ApiError(problem);
    let main;
    let thumb = null;
    if (file.type === 'image/gif') {
      main = file; // l'animation est conservée
    } else {
      let bmp;
      try { bmp = await decode(file); } catch { throw new ApiError(`Impossible de lire « ${file.name} ». Essayez avec une autre photo.`); }
      main = await encode(bmp, maxSide, 0.82);
      if (withThumb) thumb = await encode(bmp, 720, 0.78);
      if (bmp.close) bmp.close();
    }
    const up = await api('POST', '/api/admin/photos', main);
    const res = { url: up.url, thumb: up.url };
    if (thumb) res.thumb = (await api('POST', '/api/admin/photos', thumb)).url;
    return res;
  }

  /** Ouvre le sélecteur de fichiers et renvoie les fichiers choisis. */
  function pickFiles({ multiple = false } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp,image/gif,.heic,.heif';
      input.multiple = multiple;
      input.addEventListener('change', () => resolve([...input.files]));
      input.click();
    });
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      if (label) btn.textContent = label;
    } else {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
    }
  }

  function formatBytes(n) {
    if (n == null) return '—';
    if (n === 0) return '0 Ko';
    if (n < 1048576) return `${Math.max(1, Math.round(n / 1024))} Ko`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1).replace('.', ',')} Mo`;
    return `${(n / 1073741824).toFixed(1).replace('.', ',')} Go`;
  }

  window.ASLF = { src, DB, refreshUnread, api, ApiError, toast, dialog, icon, esc, $, $$, frDate, uploadPhoto, pickFiles, checkImageFile, setBusy, formatBytes, logout };

  // Sans serveur, la protection des pages se fait ici : pas de session, retour à la connexion
  (async () => {
    if (!DB) return;
    const connected = !!(await DB.token());
    const onLogin = /connexion[.]html$/.test(location.pathname);
    if (onLogin && connected) location.replace('./');
    else if (!onLogin && !connected) location.replace('connexion.html?suite=' + encodeURIComponent(herePage()));
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderChrome);
  else renderChrome();
})();
