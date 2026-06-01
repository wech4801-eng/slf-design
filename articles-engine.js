/**
 * ASLF Articles Engine
 * Injecte les articles publiés (stockés en localStorage) dans chaque page du site.
 * Auto-détecte la section en fonction du nom de fichier de la page.
 *
 * Sécurité : aucun contenu utilisateur n'est inséré via innerHTML — tout passe
 * par textContent ou par des éléments construits avec createElement.
 */
(function () {
  'use strict';

  // ── Mapping page → clé(s) de section ──────────────────────────────────────
  const PAGE_SECTIONS = {
    'diplomatie':          ['diplomatie'],
    'association':         ['association'],
    'qui-sommes-nous':     ['qui-sommes-nous'],
    'notre-but':           ['notre-but'],
    'actions-realisees':   ['actions-realisees'],
    'bulletin-adhesion':   ['bulletin-adhesion'],
    'appel-cotisation':    ['appel-cotisation'],
    'en-images':           ['en-images'],
    'medias':              ['medias'],
    'radios':              ['radios'],
    'videos':              ['videos'],
    'connaitre-somaliland':['connaitre-somaliland'],
    'liens-utiles':        ['liens-utiles'],
    'contact':             ['contact'],
  };

  // ── Mapping catégorie → classe CSS ────────────────────────────────────────
  const CAT_CLASS = {
    diplomatie:'diplomatie', humanitaire:'actions', education:'education',
    culture:'culture', actions:'actions', politique:'diplomatie',
    economie:'education', evenement:'culture', communique:'actions',
    galerie:'culture', video:'culture', radio:'culture',
  };

  // ── Détection de la page courante ─────────────────────────────────────────
  const pageName = window.location.pathname.split('/').pop().replace(/\.html?$/, '').replace(/\/$/, '') || 'index';
  const sections = PAGE_SECTIONS[pageName];
  if (!sections) return; // Page non concernée (index, news, article…)

  // ── Lecture des articles via SLFDB (temps réel) ─────────────────────────
  let published = [];
  let injected  = false;

  function updateFromArticles(allArticles) {
    if (!Array.isArray(allArticles)) return;
    published = allArticles
      .filter(a => a && a.status === 'publié' && sections.includes(a.section))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    // Si on n'a pas encore injecté de section et qu'on a maintenant des articles → injecter
    // Si on avait déjà injecté → rafraîchir la grille
    if (!injected && published.length) {
      injected = true;
      inject();
    } else if (injected) {
      const grid = document.getElementById('slf-section-grid');
      const sec  = document.getElementById('slf-section-wrap');
      if (grid) {
        grid.innerHTML = '';
        published.forEach(art => grid.appendChild(buildCard(art)));
      }
      const count = document.getElementById('slf-section-count');
      if (count) count.textContent = published.length;
      if (sec) sec.style.display = published.length ? '' : 'none';
    }
  }

  // S'abonner aux changements (SLFDB déclenche inject() via updateFromArticles)
  if (typeof SLFDB !== 'undefined') {
    SLFDB.onArticlesChange(updateFromArticles);
  } else {
    // Fallback localStorage si SLFDB pas chargé
    try { updateFromArticles(JSON.parse(localStorage.getItem('slf_articles') || '[]')); } catch {}
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' });
    } catch { return ''; }
  }

  // Filtre simple pour les URLs (évite javascript:, data:text/html, etc.)
  function safeUrl(u) {
        if (!u) return '';
        const s = String(u).trim();
        if (/^https?:\/\//i.test(s)) return s;
        if (/^data:image\//i.test(s))   return s;
        if (/^(mailto|tel):/i.test(s))  return s;
        if (!s.includes(':'))           return s; // chemin relatif sûr
        return '';
      }

  function buildCard(art) {
    const catClass = CAT_CLASS[art.categoryKey] || 'culture';
    const catLabel = art.categoryLabel || art.sectionLabel || 'Article';
    const words    = ((art.content || '').replace(/<[^>]+>/g, '') + ' ' + (art.chapeau || ''))
                       .split(/\s+/).filter(Boolean).length;
    const mins     = Math.max(1, Math.round(words / 200));

    // Lien principal
    const card = document.createElement('a');
    card.href      = 'article.html?id=' + encodeURIComponent(art.id);
    card.className = 'news-card';

    // Image / placeholder
    const cover = safeUrl(art.coverImage);
    if (cover) {
      const img = document.createElement('img');
      img.className = 'news-card-img';
      img.src = cover; img.alt = art.title || ''; img.loading = 'lazy';
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'news-card-img';
      ph.style.cssText = 'background:linear-gradient(135deg,#006830,#004d2a,#8B0000);display:flex;align-items:center;justify-content:center;font-size:48px;';
      ph.textContent = '📰';
      card.appendChild(ph);
    }

    // Corps
    const body = document.createElement('div');
    body.className = 'news-card-body';

    const cat = document.createElement('span');
    cat.className = 'news-cat ' + catClass;
    cat.style.position = 'relative';
    cat.textContent = catLabel;

    // Badge NOUVEAU si < 7 jours
    const isNew = (Date.now() - new Date(art.updatedAt).getTime()) < 7 * 24 * 60 * 60 * 1000;
    if (isNew) {
      const badge = document.createElement('span');
      badge.style.cssText = 'position:absolute;top:-8px;right:-8px;background:#CE1126;color:#fff;font-size:9px;padding:1px 5px;border-radius:4px;font-weight:700;letter-spacing:.5px;';
      badge.textContent = 'NOUVEAU';
      cat.appendChild(badge);
    }
    body.appendChild(cat);

    const h2 = document.createElement('h2');
    h2.className = 'news-title';
    h2.textContent = art.title || 'Sans titre';
    body.appendChild(h2);

    if (art.chapeau) {
      const p = document.createElement('p');
      p.className = 'news-excerpt';
      p.textContent = art.chapeau;
      body.appendChild(p);
    }

    const meta = document.createElement('div');
    meta.className = 'news-meta';
    const sDate = document.createElement('span'); sDate.textContent = fmtDate(art.updatedAt);
    const sep1  = document.createElement('span'); sep1.className = 'news-meta-dot';
    const sAuth = document.createElement('span'); sAuth.textContent = art.author || 'Rédaction ASLF';
    const sep2  = document.createElement('span'); sep2.className = 'news-meta-dot';
    const sMin  = document.createElement('span'); sMin.textContent = mins + ' min';
    meta.appendChild(sDate); meta.appendChild(sep1);
    meta.appendChild(sAuth); meta.appendChild(sep2);
    meta.appendChild(sMin);
    body.appendChild(meta);

    const more = document.createElement('span');
    more.className = 'read-more';
    more.textContent = 'Lire la suite →';
    body.appendChild(more);

    card.appendChild(body);
    return card;
  }

  // ── Injection visuelle ────────────────────────────────────────────────────
  function inject() {
    const footer = document.querySelector('footer');
    if (!footer) return;

    const section = document.createElement('div');
    section.id = 'slf-section-wrap';
    section.style.cssText = 'max-width:1200px;margin:40px auto 20px;padding:0 16px;';

    const headerWrap = document.createElement('div');
    headerWrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;';

    const h2 = document.createElement('h2');
    h2.style.cssText = 'font-size:20px;font-weight:800;color:#212529;display:flex;align-items:center;gap:8px;';
    h2.appendChild(document.createTextNode('📰 Articles publiés dans cette section '));
    const count = document.createElement('span');
    count.id = 'slf-section-count';
    count.style.cssText = 'font-size:13px;font-weight:600;background:#e8f5ee;color:#006830;padding:3px 10px;border-radius:20px;';
    count.textContent = published.length;
    h2.appendChild(count);

    const all = document.createElement('a');
    all.href = 'news.html';
    all.style.cssText = 'font-size:13px;color:#00843D;font-weight:600;text-decoration:none;';
    all.textContent = 'Voir toutes les actualités →';

    headerWrap.appendChild(h2); headerWrap.appendChild(all);
    section.appendChild(headerWrap);

    const grid = document.createElement('div');
    grid.id = 'slf-section-grid';
    grid.style.cssText = 'display:grid;grid-template-columns:1fr;gap:20px;';
    section.appendChild(grid);

    footer.parentNode.insertBefore(section, footer);

    // Style responsive
    const style = document.createElement('style');
    style.textContent = `
      @media(min-width:640px) { #slf-section-grid { grid-template-columns:1fr 1fr; } }
      @media(min-width:1024px){ #slf-section-grid { grid-template-columns:repeat(3,1fr); } }
      #slf-section-grid .news-card { background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.08); transition:transform .2s,box-shadow .2s; display:block; text-decoration:none; color:inherit; }
      #slf-section-grid .news-card:hover { transform:translateY(-3px); box-shadow:0 4px 16px rgba(0,0,0,.1); }
      #slf-section-grid .news-card-img { width:100%; aspect-ratio:16/9; object-fit:cover; display:block; }
      #slf-section-grid .news-card-body { padding:16px; }
      #slf-section-grid .news-cat { display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:3px 10px;border-radius:20px;margin-bottom:10px;position:relative; }
      #slf-section-grid .news-cat.diplomatie { background:#e8f0fe;color:#1a56db; }
      #slf-section-grid .news-cat.actions    { background:#e8f5ee;color:#006830; }
      #slf-section-grid .news-cat.education  { background:#fef3c7;color:#92400e; }
      #slf-section-grid .news-cat.culture    { background:#f0e6ff;color:#6b21a8; }
      #slf-section-grid .news-title  { font-size:15px;font-weight:700;line-height:1.3;margin-bottom:8px;color:#212529; }
      #slf-section-grid .news-excerpt{ font-size:13px;color:#6c757d;line-height:1.5;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden; }
      #slf-section-grid .news-meta   { display:flex;flex-wrap:wrap;gap:4px;font-size:11px;color:#adb5bd;margin-bottom:8px; }
      #slf-section-grid .news-meta-dot{ width:3px;height:3px;border-radius:50%;background:#adb5bd;align-self:center; }
      #slf-section-grid .read-more   { font-size:12px;font-weight:600;color:#00843D; }`;
    document.head.appendChild(style);

    published.forEach(art => grid.appendChild(buildCard(art)));
  }
  // inject() est invoqué par updateFromArticles() quand des articles arrivent
  // (pas d'appel inconditionnel ici pour éviter une section vide sur les pages
  //  sans articles publiés dans la section).
})();
