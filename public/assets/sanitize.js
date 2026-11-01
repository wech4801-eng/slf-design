/**
 * ASLF — Nettoyage du HTML des articles (liste blanche).
 *
 * Utilisé à la fois par le serveur (à chaque enregistrement) et par l'éditeur
 * (au collage depuis Word, un site web…). Le HTML est entièrement reconstruit :
 * seules les balises et attributs listés ci-dessous survivent, tout le reste
 * est retiré. Aucun attribut d'origine n'est recopié tel quel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SLFSanitize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Balises conservées → attributs autorisés
  const ALLOWED = {
    p: [], br: [], strong: [], em: [], u: [], s: [],
    h2: [], h3: [], h4: [],
    ul: [], ol: [], li: [],
    blockquote: [], hr: [],
    a: ['href'],
    img: ['src', 'alt'],
    figure: [], figcaption: [],
    iframe: ['src'],
  };
  // Balises supprimées avec tout leur contenu
  const DROP_WITH_CONTENT = new Set(['script', 'style', 'noscript', 'template', 'object', 'embed',
    'svg', 'math', 'head', 'title', 'textarea', 'select', 'button', 'form', 'video', 'audio', 'canvas', 'xml']);
  // Blocs dont on garde le texte : on laisse un espace pour ne pas coller les mots
  const SPACED = new Set(['tr', 'td', 'th', 'section', 'article', 'header', 'footer', 'pre', 'table', 'dd', 'dt']);
  const VOID = new Set(['br', 'hr', 'img']);
  const RENAME = { h1: 'h2', h5: 'h4', h6: 'h4', div: 'p', b: 'strong', i: 'em', strike: 's', del: 's' };
  const ALIGN = new Set(['center', 'right', 'justify']);
  const VIDEO_SRC = /^https:\/\/(www\.youtube(-nocookie)?\.com\/embed\/[\w-]{6,20}|player\.vimeo\.com\/video\/\d{4,12})([?#][\w\-=&.%]*)?$/i;

  function escapeText(s) {
    return String(s).replace(/&(?!(?:[a-z]{2,8}|#\d{1,7}|#x[0-9a-f]{1,6});)/gi, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function decodeEntities(s) {
    const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');
    return String(s)
      .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h) => cp(parseInt(h, 16)))
      .replace(/&#(\d{1,7});?/g, (_, d) => cp(parseInt(d, 10)))
      .replace(/&nbsp;/g, '00a0').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  /** URL sûre : http(s), mailto/tel (liens seulement), ou chemin interne au site. */
  function safeUrl(raw, kind) {
    // Caractères de contrôle et espaces retirés (contournements du type « java\tscript: »)
    const url = decodeEntities(raw || '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '');
    if (!url) return '';
    if (/^https?:\/\/[^/]/i.test(url)) return url;
    if (kind === 'href' && /^(mailto|tel):[^<>"]+$/i.test(url)) return url;
    if (/^(\/(?!\/)|\.\/|[\w-])[\w\-./%]*(\?[\w\-=&%.+]*)?(#[\w-]*)?$/.test(url) && !url.includes(':')) return url;
    return '';
  }

  function parseAttrs(str) {
    const out = {};
    const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(str))) {
      const name = m[1].toLowerCase();
      if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return out;
  }

  function buildTag(tag, attrs) {
    let html = '<' + tag;
    if (tag === 'a') {
      const href = safeUrl(attrs.href, 'href');
      if (!href) return null;
      html += ' href="' + escapeAttr(href) + '"';
      if (/^https?:/i.test(href)) html += ' target="_blank" rel="noopener noreferrer"';
    } else if (tag === 'img') {
      const src = safeUrl(attrs.src, 'src');
      if (!src) return null;
      html += ' src="' + escapeAttr(src) + '" alt="' + escapeAttr(decodeEntities(attrs.alt || '').slice(0, 300)) + '" loading="lazy" decoding="async"';
    } else if (tag === 'iframe') {
      const src = decodeEntities(attrs.src || '').trim();
      if (!VIDEO_SRC.test(src)) return null;
      html += ' src="' + escapeAttr(src) + '" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="Vidéo"';
    }
    // Seule mise en forme conservée : l'alignement du texte
    if (/^(p|h2|h3|h4|blockquote|figcaption|li)$/.test(tag)) {
      const style = decodeEntities(attrs.style || '');
      const m = /text-align\s*:\s*([a-z]+)/i.exec(style);
      const align = (m ? m[1] : attrs.align || '').toLowerCase();
      if (ALIGN.has(align)) html += ' style="text-align:' + align + '"';
    }
    return html + '>';
  }

  /** Nettoie un fragment HTML et renvoie du HTML sûr. */
  function sanitize(input) {
    if (input == null) return '';
    let html = String(input);
    if (html.length > 2000000) html = html.slice(0, 2000000);
    html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '')
      .replace(/<![^>]*>/g, '').replace(/<\?[\s\S]*?(?:\?>|$)/g, '');

    const out = [];
    const stack = [];
    const tagRe = /<\/?([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
    let last = 0;
    let dropUntil = null;
    let m;
    while ((m = tagRe.exec(html))) {
      const raw = m[0];
      const isClose = raw[1] === '/';
      let tag = m[1].toLowerCase();
      if (dropUntil) {
        if (isClose && tag === dropUntil) { dropUntil = null; last = tagRe.lastIndex; }
        continue;
      }
      if (m.index > last) out.push(escapeText(html.slice(last, m.index)));
      last = tagRe.lastIndex;

      if (DROP_WITH_CONTENT.has(tag)) { if (!isClose && !raw.endsWith('/>')) dropUntil = tag; continue; }
      if (RENAME[tag]) tag = RENAME[tag];
      if (!ALLOWED[tag]) { if (SPACED.has(tag)) out.push(' '); continue; }

      if (isClose) {
        if (VOID.has(tag)) continue;
        const idx = stack.lastIndexOf(tag);
        if (idx === -1) continue;
        while (stack.length > idx) { const t = stack.pop(); if (t[0] !== '!') out.push('</' + t + '>'); }
        continue;
      }
      const built = buildTag(tag, parseAttrs(m[2] || ''));
      if (!built) {
        // Lien refusé : on garde son texte, et on ignore sa balise fermante
        if (tag === 'a') stack.push('!a'); else if (tag === 'iframe') dropUntil = 'iframe';
        continue;
      }
      out.push(built);
      if (tag === 'iframe') { out.push('</iframe>'); dropUntil = 'iframe'; continue; }
      if (!VOID.has(tag)) stack.push(tag);
    }
    if (!dropUntil && last < html.length) out.push(escapeText(html.slice(last)));
    while (stack.length) { const t = stack.pop(); if (t[0] !== '!') out.push('</' + t + '>'); }

    return out.join('')
      .replace(/<(p|h2|h3|h4|li|blockquote|strong|em|u|s)>(\s|&nbsp;|00a0|<br>)*<\/\1>/g, '')
      .replace(/(<br>\s*){3,}/g, '<br><br>')
      .trim();
  }

  /** Texte brut (résumés, temps de lecture). */
  function toText(html) {
    return decodeEntities(String(html || '')
      .replace(/<(br|hr|\/p|\/h[2-4]|\/li|\/blockquote|\/figcaption)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  }

  return { sanitize, toText, safeUrl };
});
