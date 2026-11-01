/**
 * ASLF — Script du site public (un seul fichier, chargé en « defer »).
 *
 * Les articles sont injectés par le serveur directement dans la page
 * (<script id="aslf-data">) : aucun appel réseau supplémentaire pour les afficher.
 * Sur un hébergement statique (démo GitHub Pages), seed-articles.json sert de secours.
 */
(function () {
  'use strict';

  // ── Menu mobile (appelé par les attributs onclick des pages) ──────────────
  window.toggleMenu = function () {
    const m = document.getElementById('mobileMenu');
    if (!m) return;
    const open = m.classList.toggle('open');
    document.querySelectorAll('.hamburger').forEach((b) => b.setAttribute('aria-expanded', String(open)));
  };
  window.closeMenu = function (e) {
    if (e.target === e.currentTarget) document.getElementById('mobileMenu').classList.remove('open');
  };
  document.addEventListener('keydown', (e) => {
    const m = document.getElementById('mobileMenu');
    if (e.key === 'Escape' && m && m.classList.contains('open')) m.classList.remove('open');
  });

  // Démo sur GitHub Pages : le site vit dans un sous-dossier (/nom-du-depot/)
  const BASE = /\.github\.io$/i.test(location.hostname) ? '/' + location.pathname.split('/')[1] : '';
  const STATIC = !!BASE || location.protocol === 'file:';
  const url = (u) => (u && u.startsWith('/') && !u.startsWith('//') ? BASE + u : u || '');
  const articleUrl = (a) => 'article.html?id=' + encodeURIComponent(a.slug || a.id);

  function readData() {
    const el = document.getElementById('aslf-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
  }

  // Secours pour l'hébergement statique (aucun serveur)
  let seedPromise = null;
  function seedArticles() {
    if (!seedPromise) {
      const abs = (u) => (u ? '/' + String(u).replace(/^\/+/, '') : '');
      seedPromise = fetch(BASE + '/seed-articles.json').then((r) => (r.ok ? r.json() : []))
        .then((list) => list.filter((a) => a.status === 'publié').map((a) => ({
          ...a,
          slug: a.id,
          coverImage: abs(a.coverImage),
          coverThumb: abs(a.coverImage),
          date: a.publishedAt || a.createdAt || a.updatedAt,
          categoryLabel: a.categoryLabel || a.sectionLabel || 'Article',
          readMinutes: Math.max(1, Math.round(String(a.content || '').replace(/<[^>]+>/g, ' ').split(/\s+/).length / 200)),
        })).sort((x, y) => Date.parse(y.date) - Date.parse(x.date)))
        .catch(() => []);
    }
    return seedPromise;
  }

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  };
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ── Carte d'article (même structure que les cartes d'origine du site) ─────
  function card(a, opts = {}) {
    const link = h('a', 'news-card');
    link.href = articleUrl(a);
    const cover = url(a.coverThumb || a.coverImage);
    if (cover) {
      const img = h('img', 'news-card-img');
      img.src = cover;
      img.alt = a.coverAlt || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      link.append(img);
    } else {
      const ph = h('div', 'news-card-img news-card-placeholder');
      ph.setAttribute('aria-hidden', 'true');
      link.append(ph);
    }
    const body = h('div', 'news-card-body');
    const cat = h('span', 'news-cat ' + (a.tone || 'actions'), a.categoryLabel || a.sectionLabel || 'Article');
    body.append(cat);
    if (opts.badge && Date.now() - Date.parse(a.date) < 7 * 86400 * 1000) cat.append(h('span', 'news-new', 'Nouveau'));
    body.append(h(opts.heading || 'h3', 'news-title', a.title || 'Sans titre'));
    if (a.chapeau) body.append(h('p', 'news-excerpt', a.chapeau));
    const meta = h('div', 'news-meta');
    meta.append(h('span', null, fmtDate(a.date)));
    if (opts.author) { meta.append(h('span', 'news-meta-dot')); meta.append(h('span', null, a.author || 'Rédaction ASLF')); }
    meta.append(h('span', 'news-meta-dot'));
    meta.append(h('span', null, (a.readMinutes || 1) + ' min'));
    body.append(meta);
    if (opts.more) body.append(h('span', 'read-more', 'Lire la suite →'));
    link.append(body);
    return link;
  }

  // Styles des éléments ajoutés par ce script (badge, image absente, sections)
  const style = document.createElement('style');
  style.textContent = `
    .news-card-placeholder{background:#0b5e31 url("${BASE}/images/logo-aslf-128.webp") center/72px no-repeat}
    .news-new{position:absolute;top:-8px;right:-8px;background:#CE1126;color:#fff;font-size:9px;padding:1px 5px;border-radius:4px;font-weight:700;letter-spacing:.5px;text-transform:uppercase}
    .news-cat{position:relative}
    .aslf-more{display:flex;justify-content:center;margin:28px 0 8px}
    .aslf-more button{font:600 15px/1 inherit;padding:14px 26px;border-radius:8px;border:2px solid #00843D;background:#fff;color:#006830;cursor:pointer}
    .aslf-more button:hover{background:#e8f5ee}
    #slf-section-wrap{max-width:1200px;margin:40px auto 20px;padding:0 16px}
    #slf-section-wrap .sec-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:16px}
    #slf-section-wrap h2{font-size:20px;font-weight:800;color:#212529}
    #slf-section-wrap .sec-head a{font-size:14px;color:#006830;font-weight:600}
    #slf-section-grid{display:grid;grid-template-columns:1fr;gap:20px}
    @media(min-width:640px){#slf-section-grid{grid-template-columns:1fr 1fr}}
    @media(min-width:1024px){#slf-section-grid{grid-template-columns:repeat(3,1fr)}}
    #slf-section-grid .news-card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);display:block;text-decoration:none;color:inherit;transition:transform .2s,box-shadow .2s}
    #slf-section-grid .news-card:hover{transform:translateY(-3px);box-shadow:0 4px 16px rgba(0,0,0,.1)}
    #slf-section-grid .news-card-img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
    #slf-section-grid .news-card-body{padding:16px}
    #slf-section-grid .news-cat{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:3px 10px;border-radius:20px;margin-bottom:10px}
    #slf-section-grid .news-cat.diplomatie{background:#e8f0fe;color:#1a56db}
    #slf-section-grid .news-cat.actions{background:#e8f5ee;color:#006830}
    #slf-section-grid .news-cat.education{background:#fef3c7;color:#92400e}
    #slf-section-grid .news-cat.culture{background:#f0e6ff;color:#6b21a8}
    #slf-section-grid .news-title{font-size:16px;font-weight:700;line-height:1.3;margin-bottom:8px;color:#212529}
    #slf-section-grid .news-excerpt{font-size:14px;color:#5c636a;line-height:1.5;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    #slf-section-grid .news-meta{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:12px;color:#6c757d}
    #slf-section-grid .news-meta-dot{width:3px;height:3px;border-radius:50%;background:#adb5bd;align-self:center}
    @media (prefers-reduced-motion: reduce){.news-card{transition:none!important}}`;
  document.head.append(style);

  // ── Accueil : 3 derniers articles ─────────────────────────────────────────
  async function home(data) {
    const box = document.getElementById('dynamic-latest-container');
    const list = data ? data.articles : await seedArticles();
    const empty = document.getElementById('latest-empty');
    box.textContent = '';
    if (empty) empty.style.display = list.length ? 'none' : '';
    list.slice(0, 3).forEach((a) => box.append(card(a)));
  }

  // ── Actualités : liste complète, par pages de 24 ──────────────────────────
  async function news(data) {
    const box = document.getElementById('dynamic-news-container');
    let list = data ? data.articles : await seedArticles();
    const total = data ? data.total : list.length;
    document.querySelectorAll('.news-static-card').forEach((el) => { el.style.display = list.length ? 'none' : ''; });
    box.textContent = '';
    list.forEach((a) => box.append(card(a, { heading: 'h2', author: true, more: true, badge: true })));
    if (STATIC || list.length >= total) return;
    const wrap = h('div', 'aslf-more');
    const btn = h('button', null, 'Voir les articles plus anciens');
    btn.type = 'button';
    wrap.append(btn);
    box.parentNode.insertBefore(wrap, box.nextSibling);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Chargement…';
      try {
        const r = await fetch(`/api/articles?offset=${list.length}&limit=24`);
        const j = await r.json();
        j.articles.forEach((a) => box.append(card(a, { heading: 'h2', author: true, more: true })));
        list = list.concat(j.articles);
        if (list.length >= j.total) wrap.remove();
        else { btn.disabled = false; btn.textContent = 'Voir les articles plus anciens'; }
      } catch {
        btn.disabled = false;
        btn.textContent = 'Réessayer';
      }
    });
  }

  // ── Pages de rubrique : articles rangés dans cette rubrique ───────────────
  async function section(data) {
    let list = data && data.articles;
    if (!data) {
      const page = location.pathname.split('/').pop().replace(/\.html?$/, '');
      list = (await seedArticles()).filter((a) => a.section === page);
    }
    const footer = document.querySelector('footer');
    if (!list || !list.length || !footer) return;
    const wrap = h('section');
    wrap.id = 'slf-section-wrap';
    wrap.setAttribute('aria-labelledby', 'slf-section-title');
    const head = h('div', 'sec-head');
    const title = h('h2', null, 'Articles de cette rubrique');
    title.id = 'slf-section-title';
    const all = h('a', null, 'Toutes les actualités →');
    all.href = 'news.html';
    head.append(title, all);
    const grid = h('div');
    grid.id = 'slf-section-grid';
    list.forEach((a) => grid.append(card(a, { heading: 'h3', author: true })));
    wrap.append(head, grid);
    footer.parentNode.insertBefore(wrap, footer);
  }

  // ── Page article ──────────────────────────────────────────────────────────
  function loadSanitizer() {
    return window.SLFSanitize ? Promise.resolve(window.SLFSanitize) : new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BASE + '/assets/sanitize.js?v=1';
      s.onload = () => resolve(window.SLFSanitize);
      s.onerror = reject;
      document.head.append(s);
    });
  }

  async function article(data) {
    const wrap = document.getElementById('article-wrap');
    const params = new URLSearchParams(location.search);
    const preview = params.get('apercu') === '1';
    let a = data && data.article;
    let related = (data && data.related) || [];

    if (preview) {
      try { a = JSON.parse(localStorage.getItem('aslf_apercu') || 'null'); } catch { a = null; }
      if (a) a.content = (await loadSanitizer()).sanitize(a.content || '');
    } else if (!data && params.get('id')) {
      const list = await seedArticles();
      a = list.find((x) => x.id === params.get('id') || x.slug === params.get('id')) || null;
      if (a) related = list.filter((x) => x.id !== a.id && x.section === a.section).slice(0, 3);
    }

    const empty = document.getElementById('article-empty');
    if (!a) { wrap.style.display = 'none'; if (empty) empty.style.display = ''; return; }
    wrap.style.display = '';
    if (empty) empty.style.display = 'none';

    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    if (!data || preview) document.title = `${a.title} · ASLF`;
    set('art-cat', a.categoryLabel || a.sectionLabel || 'Article');
    set('art-title', a.title || 'Sans titre');
    set('art-intro', a.chapeau || '');
    set('art-author-name', a.author || 'Rédaction ASLF');
    set('art-author-avatar', (a.author || 'A').trim().charAt(0).toUpperCase());
    set('art-date', '📅 ' + fmtDate(a.date));
    set('art-readtime', '⏱ ' + (a.readMinutes || 1) + ' min de lecture');
    const showViews = (n) => set('art-views', '👁 ' + n.toLocaleString('fr-FR') + (n > 1 ? ' vues' : ' vue'));
    showViews(a.views || 0);

    const hero = document.getElementById('art-hero-img');
    if (hero) {
      if (a.coverImage) {
        hero.loading = 'eager';
        hero.setAttribute('fetchpriority', 'high');
        hero.src = url(a.coverImage);
        hero.alt = a.coverAlt || '';
        hero.style.display = '';
      } else hero.style.display = 'none';
    }

    const body = document.getElementById('art-body');
    if (body) {
      // Contenu déjà filtré par le serveur à l'enregistrement
      body.innerHTML = a.content && a.content.trim() ? a.content : '<p><em>Cet article n’a pas encore de contenu.</em></p>';
      if (BASE) body.querySelectorAll('img[src^="/"]').forEach((i) => { i.src = url(i.getAttribute('src')); });

      if (a.gallery && a.gallery.length) {
        const title = h('h2', null, 'Galerie photos');
        title.style.cssText = 'font-family:var(--font-display);font-size:22px;color:var(--green-dark);margin:40px 0 12px;';
        const grid = h('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:0 0 32px;';
        a.gallery.forEach((src, i) => {
          const link = h('a');
          link.href = url(src);
          link.target = '_blank';
          link.rel = 'noopener';
          link.style.cssText = 'display:block;border-radius:10px;overflow:hidden;aspect-ratio:1;background:var(--gray-100);';
          link.setAttribute('aria-label', `Agrandir la photo ${i + 1}`);
          const img = h('img');
          img.src = url(src); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
          link.append(img);
          grid.append(link);
        });
        body.append(title, grid);
      }
      (a.videos || []).forEach((v) => {
        const src = typeof v === 'string' ? v : v && v.url;
        if (!/^https:\/\/(www\.youtube-nocookie\.com\/embed\/|www\.youtube\.com\/embed\/|player\.vimeo\.com\/video\/)/.test(src || '')) return;
        const box = h('div');
        box.style.cssText = 'margin:24px 0;border-radius:12px;overflow:hidden;aspect-ratio:16/9;background:#000;';
        const f = h('iframe');
        f.src = src; f.title = 'Vidéo'; f.loading = 'lazy'; f.allowFullscreen = true;
        f.referrerPolicy = 'strict-origin-when-cross-origin';
        f.setAttribute('allow', 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen');
        f.style.cssText = 'width:100%;height:100%;border:0;';
        box.append(f);
        body.append(box);
      });
    }

    const tags = document.querySelector('.tags');
    if (tags && a.tags && a.tags.length) {
      tags.textContent = '';
      a.tags.forEach((t) => tags.append(h('span', 'tag', '#' + t)));
      tags.style.display = '';
    }

    const crumbs = document.querySelector('.breadcrumb');
    if (crumbs) {
      crumbs.textContent = '';
      const home = h('a', null, 'Accueil');
      home.href = './';
      crumbs.append(home, document.createTextNode(' › '));
      if (a.sectionPage) {
        const s = h('a', null, a.sectionLabel);
        s.href = a.sectionPage;
        crumbs.append(s, document.createTextNode(' › '));
      }
      crumbs.append(h('span', null, a.title.length > 48 ? a.title.slice(0, 47) + '…' : a.title));
      if (data && data.admin && !preview) {
        const edit = h('a', null, '✏️ Modifier cet article');
        edit.href = '/admin/article.html?id=' + encodeURIComponent(a.id);
        edit.style.cssText = 'margin-left:12px;font-size:12px;color:var(--green);border:1px solid var(--green);padding:2px 8px;border-radius:4px;';
        crumbs.append(edit);
      }
    }

    const relGrid = document.querySelector('.related-grid');
    if (relGrid && related.length && !preview) {
      relGrid.textContent = '';
      related.slice(0, 2).forEach((r) => {
        const link = h('a', 'related-card');
        link.href = articleUrl(r);
        if (r.coverThumb || r.coverImage) {
          const img = h('img', 'related-img');
          img.src = url(r.coverThumb || r.coverImage); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
          img.style.objectFit = 'cover';
          link.append(img);
        }
        const b = h('div', 'related-body');
        b.append(h('h4', null, r.title), h('div', 'related-meta', fmtDate(r.date)));
        link.append(b);
        relGrid.append(link);
      });
      const rel = document.querySelector('.related');
      if (rel) rel.style.display = '';
    }

    if (preview || (data && data.draft)) {
      const bar = h('div');
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#1b2420;color:#fff;padding:12px 20px;font:600 15px/1.4 Inter,system-ui,sans-serif;text-align:center;';
      bar.textContent = preview
        ? 'Aperçu : voici à quoi ressemblera l’article. Il n’est ni enregistré ni publié. Fermez cet onglet pour revenir à l’éditeur.'
        : 'Brouillon : cet article n’est visible que par vous, car vous êtes connecté à l’espace de gestion.';
      document.body.prepend(bar);
    } else if (!STATIC && a.id && !(data && data.admin)) {
      fetch(`/api/articles/${encodeURIComponent(a.id)}/vue`, { method: 'POST' })
        .then((r) => r.json()).then((j) => { if (j && j.views) showViews(j.views); }).catch(() => {});
    }
  }

  // ── Partage ───────────────────────────────────────────────────────────────
  window.shareOn = function (network) {
    const u = encodeURIComponent(location.href);
    const t = encodeURIComponent(document.title);
    const targets = {
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
      twitter: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
      whatsapp: `https://api.whatsapp.com/send?text=${t}%20${u}`,
    };
    if (targets[network]) window.open(targets[network], '_blank', 'noopener,noreferrer,width=600,height=520');
  };
  window.copyArticleLink = function (btn) {
    const original = btn.textContent;
    const done = (ok) => { btn.textContent = ok ? '✓ Lien copié' : '✗ Échec'; setTimeout(() => { btn.textContent = original; }, 1800); };
    (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject(new Error('indisponible'))).then(() => done(true), () => done(false));
  };

  // ── Formulaire de contact ─────────────────────────────────────────────────
  window.submitForm = async function (e) {
    e.preventDefault();
    const form = document.getElementById('contactForm');
    let msg = document.getElementById('contactError');
    if (!msg) {
      msg = h('p');
      msg.id = 'contactError';
      msg.setAttribute('role', 'alert');
      msg.style.cssText = 'display:none;margin:0 0 16px;padding:12px 16px;border-radius:8px;background:#fdecea;color:#8b0000;font-weight:600;';
      form.prepend(msg);
    }
    const fail = (t) => { msg.textContent = t; msg.style.display = 'block'; msg.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    const v = (n) => (form.elements[n] ? String(form.elements[n].value || '').trim() : '');
    if (!v('nom') || !v('email') || !v('sujet') || !v('message')) return fail('Merci de remplir tous les champs marqués d’une étoile.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))) return fail('L’adresse e-mail ne semble pas correcte.');
    if (form.elements.consent && !form.elements.consent.checked) return fail('Merci de cocher la case d’accord pour que nous puissions vous répondre.');
    if (STATIC) return fail('Le formulaire fonctionne uniquement sur le site officiel. Écrivez-nous à somalilande.france@gmail.com.');
    const btn = form.querySelector('[type="submit"]');
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi en cours…'; }
    msg.style.display = 'none';
    try {
      const r = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ASLF' },
        body: JSON.stringify({ nom: v('nom'), email: v('email'), telephone: v('telephone'), sujet: v('sujet'), message: v('message'), site: v('site') }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'L’envoi a échoué.');
      form.style.display = 'none';
      const ok = document.getElementById('formSuccess');
      if (ok) { ok.style.display = 'block'; ok.setAttribute('tabindex', '-1'); ok.focus(); }
    } catch (err) {
      fail((err && err.message) || 'L’envoi a échoué. Vérifiez votre connexion et réessayez.');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  };

  // ── Démarrage ─────────────────────────────────────────────────────────────
  const data = readData();
  const run = (fn) => fn(data).catch((e) => console.error(e));
  if (document.getElementById('dynamic-latest-container')) run(home);
  else if (document.getElementById('dynamic-news-container')) run(news);
  else if (document.getElementById('article-wrap')) run(article);
  else if ((data && data.section) || (!data && STATIC)) run(section);
})();
