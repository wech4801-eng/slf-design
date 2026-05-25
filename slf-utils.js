/**
 * SLF Utils — fonctions partagées pour échappement HTML, formatage, etc.
 * Sans dépendance, à inclure avant tout script qui rend du HTML utilisateur.
 */
(function (global) {
  'use strict';

  // ── Échappement HTML ──────────────────────────────────────────────────────
  // Empêche l'injection de balises et de gestionnaires d'événements depuis
  // le contenu utilisateur stocké dans localStorage.
  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#47;',
    '`': '&#96;',
  };
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`/]/g, (ch) => HTML_ESCAPES[ch]);
  }

  // ── Échappement d'attribut (alias d'escapeHtml, suffisant pour " et ') ────
  function escapeAttr(value) {
    return escapeHtml(value);
  }

  // ── Filtre de schéma d'URL ────────────────────────────────────────────────
  // Empêche les javascript:..., data:text/html, vbscript:, etc.
  // Seuls http(s), mailto, tel, data:image, data:video et chemins relatifs
  // sont conservés. Tout le reste est remplacé par "#".
  function sanitizeUrl(url) {
    if (!url) return '';
    const str = String(url).trim();
    // URL relative ou ancrage = sûr
    if (/^[^a-zA-Z]/.test(str) || /^[./?#]/.test(str)) return str;
    const lower = str.toLowerCase();
    if (/^(https?:|mailto:|tel:|ftp:)/.test(lower)) return str;
    if (/^data:(image|video)\//.test(lower))         return str;
    // Cas non listés (javascript:, vbscript:, data:text/html …) → bloqué
    return '#';
  }

  // ── Nettoyage léger du contenu HTML stocké ───────────────────────────────
  // Retire <script>, on*=, javascript:, iframes non-http
  function sanitizeArticleHtml(html) {
    if (!html) return '';
    try {
      const tpl = document.createElement('template');
      tpl.innerHTML = String(html);
      const tree = tpl.content;
      const all = tree.querySelectorAll('*');
      all.forEach((el) => {
        const tag = el.tagName.toLowerCase();
        // Supprimer scripts, styles, objects, embeds
        if (['script', 'style', 'object', 'embed', 'link', 'meta'].includes(tag)) {
          el.remove();
          return;
        }
        // Iframes : conserver seulement si src http(s)
        if (tag === 'iframe') {
          const src = el.getAttribute('src') || '';
          if (!/^https?:\/\//i.test(src)) { el.remove(); return; }
        }
        // Nettoyer attributs dangereux
        [...el.attributes].forEach(({ name, value }) => {
          if (/^on/i.test(name)) el.removeAttribute(name);
          else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) el.removeAttribute(name);
        });
      });
      return tpl.innerHTML;
    } catch {
      // En cas d'erreur, on échappe tout
      return escapeHtml(html);
    }
  }

  // ── Date FR ───────────────────────────────────────────────────────────────
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('fr-FR', {
        day: 'numeric', month: 'long', year: 'numeric'
      });
    } catch { return ''; }
  }

  // ── Lecture sûre des articles ─────────────────────────────────────────────
  function getArticles() {
    try {
      const raw = JSON.parse(localStorage.getItem('slf_articles') || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  // ── Validation taille fichier ─────────────────────────────────────────────
  // localStorage ≈ 5 Mo total. On bloque tout fichier > 1.5 Mo en base64
  // (= ~1.1 Mo binaire) pour éviter le crash de quota.
  const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 3   * 1024 * 1024;

  function validateImageFile(file) {
    if (!file) return { ok: false, reason: 'Aucun fichier' };
    if (!file.type.startsWith('image/'))
      return { ok: false, reason: 'Format non supporté (image requise)' };
    // Garde-fou : on refuse uniquement les fichiers > 25 Mo
    // (la compression auto ramènera le reste sous le quota localStorage)
    if (file.size > 25 * 1024 * 1024)
      return { ok: false, reason: `Image beaucoup trop lourde (${Math.round(file.size/1024/1024)} Mo, max 25 Mo)` };
    return { ok: true };
  }

  // ── Compression / redimensionnement d'image via Canvas ────────────────────
  // Charge le fichier, le redimensionne si besoin (côté max ≤ maxDim) et le
  // recompresse en JPEG. Si le data URL résultant dépasse maxBytes, on baisse
  // la qualité par paliers, puis on réduit les dimensions. Renvoie une
  // promesse résolue avec la data URL finale.
  function compressImage(file, opts = {}) {
    const maxDim   = opts.maxDim   || 1600;
    const maxBytes = opts.maxBytes || MAX_IMAGE_BYTES;
    const mime     = opts.mime     || 'image/jpeg';

    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        reject(new Error('Fichier image attendu'));
        return;
      }

      // GIF : on ne touche pas (perte d'animation à la conversion)
      if (file.type === 'image/gif' && file.size <= maxBytes) {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
        return;
      }

      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        // Redimensionnement initial
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width  = Math.round(width  * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);

        // Première compression
        let quality = 0.85;
        let dataUrl = canvas.toDataURL(mime, quality);

        // Si trop gros, on baisse la qualité par paliers
        while (estimateBytes(dataUrl) > maxBytes && quality > 0.4) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL(mime, quality);
        }

        // Toujours trop gros → on réduit aussi les dimensions
        while (estimateBytes(dataUrl) > maxBytes && (canvas.width > 600 || canvas.height > 600)) {
          canvas.width  = Math.round(canvas.width  * 0.85);
          canvas.height = Math.round(canvas.height * 0.85);
          const ctx2 = canvas.getContext('2d');
          ctx2.drawImage(img, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL(mime, 0.75);
        }
        resolve(dataUrl);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Lecture image impossible')); };
      img.src = url;
    });
  }

  // Estime le poids en octets d'une data URL base64
  function estimateBytes(dataUrl) {
    if (!dataUrl) return 0;
    const i = dataUrl.indexOf(',');
    const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    return Math.ceil(b64.length * 3 / 4);
  }

  function validateVideoFile(file, maxBytes = MAX_VIDEO_BYTES) {
    if (!file) return { ok: false, reason: 'Aucun fichier' };
    if (!file.type.startsWith('video/'))
      return { ok: false, reason: 'Format non supporté (vidéo requise)' };
    if (file.size > maxBytes)
      return { ok: false, reason: `Vidéo trop lourde (${Math.round(file.size/1024/1024)} Mo, max ${Math.round(maxBytes/1024/1024)} Mo) — préférez un lien YouTube/Vimeo` };
    return { ok: true };
  }

  global.SLFUtils = {
    escapeHtml,
    escapeAttr,
    sanitizeUrl,
    sanitizeArticleHtml,
    fmtDate,
    getArticles,
    validateImageFile,
    validateVideoFile,
    compressImage,
    estimateBytes,
    MAX_IMAGE_BYTES,
    MAX_VIDEO_BYTES,
  };
})(window);
