/**
 * ASLF — Éditeur d'article guidé.
 * Enregistrement sur le serveur, copie de secours automatique dans le navigateur,
 * photos réduites avant envoi, collage depuis Word nettoyé.
 */
(function () {
  'use strict';
  const { api, toast, dialog, icon, esc, frDate, uploadPhoto, pickFiles, setBusy, $ } = window.ASLF;
  const CFG = window.SLFConfig;
  const SAN = window.SLFSanitize;

  const params = new URLSearchParams(location.search);
  let id = params.get('id') || null;
  let server = null;          // dernière version enregistrée sur le serveur
  let savedSnapshot = '';     // pour savoir s'il reste des modifications non enregistrées
  let saving = false;
  let uploads = 0;

  const el = {
    title: $('#title'), chapeau: $('#chapeau'), content: $('#content'), coverAlt: $('#cover-alt'),
    author: $('#author'), category: $('#category'), publishAt: $('#publish-at'),
    seoTitle: $('#seo-title'), metaDesc: $('#meta-desc'), slug: $('#slug'),
    primary: $('#btn-primary'), secondary: $('#btn-secondary'), preview: $('#btn-preview'),
  };
  const state = { coverImage: '', coverThumb: '', gallery: [], videos: [], section: 'news' };

  // ── Outils ────────────────────────────────────────────────────────────────
  const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/['’]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const pad = (n) => String(n).padStart(2, '0');
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fromLocalInput(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d) ? null : d.toISOString();
  }
  function videoInfo(url) {
    const s = String(url || '');
    let m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,20})/i.exec(s);
    if (m) return { url: `https://www.youtube-nocookie.com/embed/${m[1]}`, thumb: `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg`, label: 'Vidéo YouTube' };
    m = /vimeo\.com\/(?:video\/)?(\d{4,12})/i.exec(s);
    if (m) return { url: `https://player.vimeo.com/video/${m[1]}`, thumb: '', label: 'Vidéo Vimeo' };
    return null;
  }

  // ── Lecture / écriture du formulaire ──────────────────────────────────────
  function collect() {
    return {
      title: el.title.value.trim(),
      chapeau: el.chapeau.value.trim(),
      content: SAN.sanitize(el.content.innerHTML),
      coverImage: state.coverImage,
      coverThumb: state.coverThumb,
      coverAlt: el.coverAlt.value.trim(),
      section: state.section,
      categoryKey: el.category.value,
      author: el.author.value.trim(),
      gallery: state.gallery.slice(),
      videos: state.videos.slice(),
      publishAt: fromLocalInput(el.publishAt.value),
      seoTitle: el.seoTitle.value.trim(),
      metaDesc: el.metaDesc.value.trim(),
      slug: el.slug.value.trim(),
    };
  }
  const snapshot = () => JSON.stringify(collect());
  const isDirty = () => snapshot() !== savedSnapshot;

  function fill(a) {
    el.title.value = a.title || '';
    el.chapeau.value = a.chapeau || '';
    el.content.innerHTML = SAN.sanitize(a.content || '');
    el.coverAlt.value = a.coverAlt || '';
    el.author.value = a.author || '';
    el.category.value = a.categoryKey || '';
    el.publishAt.value = a.status === 'planifié' && a.publishAt ? toLocalInput(a.publishAt) : '';
    el.seoTitle.value = a.seoTitle || '';
    el.metaDesc.value = a.metaDesc || '';
    el.slug.value = a.slug || '';
    state.coverImage = a.coverImage || '';
    state.coverThumb = a.coverThumb || '';
    state.gallery = (a.gallery || []).slice();
    state.videos = (a.videos || []).map((v) => (typeof v === 'string' ? v : v.url)).filter(Boolean);
    state.section = CFG.section(a.section).key;
    if (el.publishAt.value) $('#more-schedule').open = true;
    if (state.gallery.length) $('#more-gallery').open = true;
    if (state.videos.length) $('#more-video').open = true;
    renderAll();
  }

  function renderAll() {
    renderCover(); renderGallery(); renderVideos(); renderSections();
    autosize(); countChapeau(); countWords(); refreshEmpty(); slugHint(); updateBar();
  }

  // ── 1. Titre ──────────────────────────────────────────────────────────────
  function autosize() { el.title.style.height = 'auto'; el.title.style.height = el.title.scrollHeight + 'px'; }
  el.title.addEventListener('input', () => { autosize(); slugHint(); $('#title-error').hidden = true; el.title.removeAttribute('aria-invalid'); });
  el.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.chapeau.focus(); } });

  // ── 2. Résumé ─────────────────────────────────────────────────────────────
  function countChapeau() {
    const n = el.chapeau.value.length;
    const c = $('#chapeau-count');
    c.textContent = `${n} / 300`;
    c.classList.toggle('over', n > 300);
  }
  el.chapeau.addEventListener('input', countChapeau);

  // ── 3. Photo principale ───────────────────────────────────────────────────
  function renderCover() {
    const has = !!state.coverImage;
    $('#cover-drop').hidden = has;
    $('#cover-preview').hidden = !has;
    if (has) $('#cover-img').src = state.coverImage;
  }

  async function setCover(file) {
    if (!file) return;
    const pick = $('#cover-pick');
    const text = $('#cover-drop-text');
    uploads++;
    $('#cover-drop').hidden = false;
    $('#cover-preview').hidden = true;
    setBusy(pick, true, 'Envoi de la photo…');
    text.textContent = 'La photo est réduite puis envoyée, patientez quelques secondes…';
    try {
      const up = await uploadPhoto(file, { maxSide: 1600, withThumb: true });
      state.coverImage = up.url;
      state.coverThumb = up.thumb;
      changed();
      toast('Photo ajoutée.');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      uploads--;
      setBusy(pick, false);
      text.textContent = 'ou faites glisser une photo ici';
      renderCover();
    }
  }

  $('#cover-pick').addEventListener('click', async () => setCover((await pickFiles())[0]));
  $('#cover-change').addEventListener('click', async () => setCover((await pickFiles())[0]));
  $('#cover-remove').addEventListener('click', () => {
    state.coverImage = ''; state.coverThumb = '';
    renderCover(); changed();
  });
  const drop = $('#cover-drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    setCover([...e.dataTransfer.files].find((f) => f.type.startsWith('image/') || /\.hei[cf]$/i.test(f.name)));
  });

  // ── 4. Texte (éditeur) ────────────────────────────────────────────────────
  const rte = el.content;
  let savedRange = null;

  const inEditor = (node) => node && (node === rte || rte.contains(node));
  function rememberRange() {
    const sel = getSelection();
    if (sel.rangeCount && inEditor(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  }
  function restoreRange() {
    rte.focus();
    if (!savedRange) {
      const r = document.createRange(); r.selectNodeContents(rte); r.collapse(false); savedRange = r;
    }
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(savedRange);
  }
  function exec(cmd, val = null) { rte.focus(); document.execCommand(cmd, false, val); afterEdit(); }
  function currentBlock() {
    try { return String(document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, ''); } catch { return ''; }
  }

  function refreshEmpty() {
    rte.classList.toggle('is-empty', !rte.textContent.trim() && !rte.querySelector('img,iframe'));
  }
  function countWords() {
    const words = SAN.toText(rte.innerHTML).split(' ').filter(Boolean).length;
    $('#words').textContent = words
      ? `${words} mot${words > 1 ? 's' : ''} · environ ${Math.max(1, Math.round(words / 200))} min de lecture`
      : '';
  }
  function afterEdit() { refreshEmpty(); countWords(); refreshToolbar(); changed(); }

  function refreshToolbar() {
    const block = currentBlock();
    document.querySelectorAll('#rte-bar [data-cmd][aria-pressed]').forEach((b) => {
      let on = false;
      try { on = document.queryCommandState(b.dataset.cmd); } catch {}
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('#rte-bar [data-block]').forEach((b) => b.setAttribute('aria-pressed', String(block === b.dataset.block)));
  }

  rte.addEventListener('focus', () => { try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {} });
  rte.addEventListener('input', () => {
    // Le premier texte tapé dans une zone vide devient un vrai paragraphe
    const first = rte.firstChild;
    if (first && first.nodeType === 3 && first.textContent.trim()) document.execCommand('formatBlock', false, '<p>');
    afterEdit();
  });
  document.addEventListener('selectionchange', () => { if (inEditor(getSelection().anchorNode)) { rememberRange(); refreshToolbar(); } });

  $('#rte-bar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#rte-bar').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.cmd) return exec(b.dataset.cmd);
    if (b.dataset.block) {
      rte.focus();
      return exec('formatBlock', currentBlock() === b.dataset.block ? '<p>' : `<${b.dataset.block}>`);
    }
    if (b.dataset.action === 'link') return addLink();
    if (b.dataset.action === 'photo') { rememberRange(); return addInlinePhoto((await pickFiles())[0]); }
  });

  async function addLink() {
    rememberRange();
    const selected = savedRange && !savedRange.collapsed ? savedRange.toString() : '';
    const fields = [{ name: 'url', label: 'Adresse du site (copiez-la depuis la barre d’adresse)', placeholder: 'https://www.exemple.fr', required: true }];
    if (!selected) fields.push({ name: 'text', label: 'Texte à afficher', placeholder: 'Par exemple : le communiqué officiel' });
    const res = await dialog({ title: 'Ajouter un lien', text: selected ? `Le texte « ${selected.slice(0, 80)} » deviendra cliquable.` : '', ok: 'Ajouter le lien', fields });
    if (!res || !res.url.trim()) return restoreRange();
    let url = res.url.trim();
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(url)) url = 'mailto:' + url;
    else if (!/^(https?:|mailto:|tel:|\/)/i.test(url)) url = 'https://' + url;
    if (!SAN.safeUrl(url, 'href')) { toast('Cette adresse ne semble pas valide.', 'error'); return restoreRange(); }
    restoreRange();
    if (selected) exec('createLink', url);
    else exec('insertHTML', `<a href="${esc(url)}">${esc(res.text || url)}</a>&nbsp;`);
  }

  async function addInlinePhoto(file) {
    if (!file) return;
    uploads++;
    toast('Envoi de la photo…');
    try {
      const up = await uploadPhoto(file, { maxSide: 1400 });
      restoreRange();
      exec('insertHTML', `<p><img src="${esc(up.url)}" alt=""></p><p><br></p>`);
      toast('Photo ajoutée dans le texte.');
    } catch (e) { toast(e.message, 'error'); }
    finally { uploads--; }
  }

  // Collage : on ne garde qu'une mise en forme propre (gras, intertitres, listes, liens)
  rte.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const file = [...dt.files].find((f) => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); rememberRange(); addInlinePhoto(file); return; }
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    e.preventDefault();
    let clean = '';
    if (html) {
      // Les images collées depuis Word pointent vers l'ordinateur : inutilisables sur le site
      clean = SAN.sanitize(html).replace(/<img src="(?!\/uploads\/|https?:)[^"]*"[^>]*>/g, '');
    }
    if (!clean && text) {
      clean = text.split(/\r?\n\s*\r?\n/).map((p) => `<p>${esc(p.trim()).replace(/\r?\n/g, '<br>')}</p>`).join('');
    }
    if (clean) document.execCommand('insertHTML', false, clean);
    afterEdit();
  });
  rte.addEventListener('drop', (e) => {
    const file = [...((e.dataTransfer && e.dataTransfer.files) || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if (pos) savedRange = pos; else rememberRange();
    addInlinePhoto(file);
  });
  rte.addEventListener('click', (e) => { if (e.target.closest('a')) e.preventDefault(); });

  // ── 5. Rubrique ───────────────────────────────────────────────────────────
  function renderSections() {
    $('#sections').innerHTML = CFG.SECTIONS.map((s) => `
      <label class="choice">
        <input type="radio" name="section" value="${esc(s.key)}"${s.key === state.section ? ' checked' : ''}>
        <span><strong>${esc(s.label)}</strong><small>${esc(s.help)}</small></span>
      </label>`).join('');
  }
  $('#sections').addEventListener('change', (e) => { state.section = e.target.value; changed(); });
  el.category.insertAdjacentHTML('beforeend', CFG.CATEGORIES.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join(''));

  // ── 6. Galerie et vidéos ──────────────────────────────────────────────────
  function renderGallery() {
    $('#gallery').innerHTML = state.gallery.map((u, i) => `
      <figure><img src="${esc(u)}" alt="" loading="lazy">
        <button type="button" data-remove-photo="${i}" aria-label="Retirer la photo ${i + 1}">${icon('x')}</button></figure>`).join('');
    $('#gallery-count').textContent = state.gallery.length ? `(${state.gallery.length})` : '';
  }
  $('#gallery').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove-photo]');
    if (!b) return;
    state.gallery.splice(+b.dataset.removePhoto, 1);
    renderGallery(); changed();
  });
  $('#gallery-add').addEventListener('click', async () => {
    const files = await pickFiles({ multiple: true });
    if (!files.length) return;
    const btn = $('#gallery-add');
    const status = $('#gallery-status');
    setBusy(btn, true, 'Envoi en cours…');
    uploads++;
    const errors = [];
    for (let i = 0; i < files.length; i++) {
      status.textContent = ` Photo ${i + 1} sur ${files.length}…`;
      try { state.gallery.push((await uploadPhoto(files[i], { maxSide: 1600 })).url); renderGallery(); }
      catch (e) { errors.push(e.message); }
    }
    uploads--;
    setBusy(btn, false);
    status.textContent = '';
    changed();
    if (errors.length) toast(errors[0], 'error');
    else toast(files.length > 1 ? `${files.length} photos ajoutées.` : 'Photo ajoutée.');
  });

  function renderVideos() {
    $('#videos').innerHTML = state.videos.map((u, i) => {
      const v = videoInfo(u) || { thumb: '', label: 'Vidéo' };
      return `<div class="video-row">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy">` : ''}
        <span>${esc(v.label)}</span>
        <button class="btn btn-ghost danger" type="button" data-remove-video="${i}">${icon('x')}Retirer</button></div>`;
    }).join('');
    $('#video-count').textContent = state.videos.length ? `(${state.videos.length})` : '';
  }
  $('#videos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove-video]');
    if (!b) return;
    state.videos.splice(+b.dataset.removeVideo, 1);
    renderVideos(); changed();
  });
  $('#video-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#video-url');
    const v = videoInfo(input.value.trim());
    if (!v) { toast('Ce lien n’est pas une vidéo YouTube ou Vimeo. Copiez le lien depuis le bouton « Partager ».', 'error'); return; }
    state.videos.push(v.url);
    input.value = '';
    renderVideos(); changed();
    toast('Vidéo ajoutée.');
  });

  function slugHint() {
    const s = el.slug.value.trim() || slugify(el.title.value);
    $('#slug-hint').textContent = s ? `L’article sera à l’adresse : ${location.origin}/article.html?id=${s}` : '';
  }
  el.slug.addEventListener('input', slugHint);

  // ── Copie de secours dans le navigateur ───────────────────────────────────
  const localKey = () => 'aslf_brouillon_' + (id || 'nouveau');
  let localTimer = null;
  function writeLocal() {
    clearTimeout(localTimer);
    localTimer = setTimeout(() => {
      try {
        if (isDirty()) localStorage.setItem(localKey(), JSON.stringify({ savedAt: Date.now(), data: collect() }));
        else localStorage.removeItem(localKey());
      } catch {}
    }, 1200);
  }
  function readLocal() {
    try { return JSON.parse(localStorage.getItem(localKey()) || 'null'); } catch { return null; }
  }
  function clearLocal(key = localKey()) { try { localStorage.removeItem(key); } catch {} }

  function offerRecovery() {
    const local = readLocal();
    if (!local || !local.data) return;
    if (JSON.stringify(local.data) === savedSnapshot || (server && local.savedAt < Date.parse(server.updatedAt))) { clearLocal(); return; }
    $('#recover-when').textContent = `Modifié ${frDate(new Date(local.savedAt).toISOString(), true)}, sur cet appareil.`;
    $('#recover').hidden = false;
    $('#recover-yes').onclick = () => {
      fill({ ...(server || {}), ...local.data, status: server ? server.status : 'brouillon', publishAt: local.data.publishAt });
      if (local.data.publishAt) { el.publishAt.value = toLocalInput(local.data.publishAt); $('#more-schedule').open = true; }
      $('#recover').hidden = true;
      updateBar();
      toast('Texte récupéré. Pensez à enregistrer.');
    };
    $('#recover-no').onclick = () => { clearLocal(); $('#recover').hidden = true; };
  }

  // ── Barre d'actions ───────────────────────────────────────────────────────
  function scheduledFuture() {
    const iso = fromLocalInput(el.publishAt.value);
    return iso && Date.parse(iso) > Date.now() ? iso : null;
  }

  function updateBar() {
    const dirty = isDirty();
    const dot = $('#state-dot');
    const text = $('#state-text');
    const isPublic = !!(server && server.isPublic);
    dot.className = 'dot';
    if (!server) {
      if (dirty) dot.classList.add('dirty');
      text.innerHTML = '<strong>Nouvel article.</strong> Pas encore enregistré.';
    } else if (dirty) {
      dot.classList.add('dirty');
      text.innerHTML = isPublic
        ? '<strong>Modifications non enregistrées.</strong> Le site affiche encore l’ancienne version.'
        : '<strong>Modifications non enregistrées.</strong>';
    } else if (isPublic) {
      dot.classList.add('online');
      text.innerHTML = `<strong>En ligne sur le site.</strong> Enregistré ${esc(frDate(server.updatedAt, true))}.`;
    } else if (server.status === 'planifié') {
      text.innerHTML = `<strong>Programmé :</strong> sera publié ${esc(frDate(server.publishAt, true))}.`;
    } else {
      text.innerHTML = `<strong>Brouillon enregistré</strong> ${esc(frDate(server.updatedAt, true))}. Pas visible sur le site.`;
    }

    if (isPublic) {
      el.secondary.textContent = 'Retirer du site';
      el.secondary.dataset.mode = 'retirer';
      el.primary.innerHTML = `${icon('save')}Enregistrer les modifications`;
    } else {
      el.secondary.textContent = 'Enregistrer sans publier';
      el.secondary.dataset.mode = 'brouillon';
      el.primary.innerHTML = scheduledFuture() ? `${icon('calendar-clock')}Programmer la publication` : `${icon('send')}Publier sur le site`;
    }
    el.primary.dataset.mode = 'publier';
  }

  let barTimer = null;
  function changed() {
    clearTimeout(barTimer);
    barTimer = setTimeout(updateBar, 120);
    writeLocal();
  }
  document.addEventListener('input', (e) => { if (e.target.closest && e.target.closest('#editor')) changed(); });
  document.addEventListener('change', (e) => { if (e.target.closest && e.target.closest('#editor')) changed(); });

  // ── Enregistrement ────────────────────────────────────────────────────────
  async function save(mode) {
    if (saving) return;
    if (uploads > 0) { toast('Une photo est encore en cours d’envoi. Patientez quelques secondes.', 'error'); return; }
    const data = collect();
    if (!data.title) {
      $('#title-error').hidden = false;
      el.title.setAttribute('aria-invalid', 'true');
      el.title.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.title.focus({ preventScroll: true });
      return;
    }
    const wasPublic = !!(server && server.isPublic);
    const schedule = scheduledFuture();
    let status = 'brouillon';

    if (mode === 'publier') {
      if (el.publishAt.value && !schedule && !wasPublic) {
        toast('La date de publication programmée est déjà passée. Changez-la, ou videz la case pour publier tout de suite.', 'error');
        $('#more-schedule').open = true;
        el.publishAt.focus();
        return;
      }
      status = schedule && !wasPublic ? 'planifié' : 'publié';
      const hasText = SAN.toText(data.content).length > 0 || /<(img|iframe)/.test(data.content);
      if (!hasText && !data.gallery.length && !data.videos.length) {
        const ok = await dialog({ title: 'L’article est vide', text: 'Il n’y a pas encore de texte à l’étape 4. Voulez-vous vraiment publier ?', ok: 'Publier quand même', cancel: 'Écrire le texte' });
        if (!ok) { rte.focus(); return; }
      }
      if (!data.coverImage && !wasPublic) {
        const ok = await dialog({ title: 'Publier sans photo ?', text: 'Un article avec une photo attire beaucoup plus de lecteurs.', ok: 'Publier sans photo', cancel: 'Ajouter une photo' });
        if (!ok) { $('#step-photo').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      }
    } else if (mode === 'retirer') {
      const ok = await dialog({ title: 'Retirer l’article du site ?', text: 'Il ne sera plus visible par les visiteurs, mais restera dans vos brouillons. Vous pourrez le republier quand vous voudrez.', ok: 'Retirer du site', danger: true });
      if (!ok) return;
    }

    saving = true;
    const btn = mode === 'publier' ? el.primary : el.secondary;
    setBusy(btn, true, 'Enregistrement…');
    try {
      const previousKey = localKey();
      const res = id
        ? await api('PUT', `/api/admin/articles/${encodeURIComponent(id)}`, { ...data, status })
        : await api('POST', '/api/admin/articles', { ...data, status });
      server = res;
      id = res.id;
      clearLocal(previousKey);
      history.replaceState(null, '', `/admin/article.html?id=${encodeURIComponent(id)}`);
      el.slug.value = res.slug;
      savedSnapshot = snapshot();
      clearLocal();
      try { if (data.author) localStorage.setItem('aslf_auteur', data.author); } catch {}
      $('#page-title').textContent = 'Modifier l’article';

      if (mode === 'publier' && !wasPublic) { showDone(res, status === 'planifié'); return; }
      if (mode === 'publier') toast('Modifications enregistrées : elles sont déjà visibles sur le site.');
      else if (mode === 'retirer') toast('L’article est retiré du site. Il reste dans vos brouillons.');
      else toast('Brouillon enregistré. Il n’est pas visible sur le site.');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      saving = false;
      setBusy(btn, false);
      updateBar();
    }
  }

  function showDone(a, scheduled) {
    $('#editor').hidden = true;
    $('#actionbar').hidden = true;
    $('#done').hidden = false;
    if (scheduled) {
      $('#done-title').textContent = 'C’est programmé !';
      $('#done-text').textContent = `Votre article sera publié automatiquement ${frDate(a.publishAt, true)}.`;
      $('#done-view').hidden = true;
    }
    $('#done-view').href = `/article.html?id=${encodeURIComponent(a.slug)}`;
    window.scrollTo(0, 0);
    $('#done-box').focus();
  }

  el.primary.addEventListener('click', () => save(el.primary.dataset.mode));
  el.secondary.addEventListener('click', () => save(el.secondary.dataset.mode));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save(server && server.isPublic ? 'publier' : 'brouillon');
    }
  });

  // Aperçu : la page publique affiche ce brouillon sans rien enregistrer
  el.preview.addEventListener('click', () => {
    const data = collect();
    const sec = CFG.section(data.section);
    const cat = CFG.category(data.categoryKey);
    const preview = {
      ...data,
      title: data.title || 'Sans titre',
      sectionLabel: sec.label, sectionPage: sec.page,
      categoryLabel: cat ? cat.label : sec.label, tone: cat ? cat.tone : 'actions',
      author: data.author || 'Rédaction ASLF',
      date: data.publishAt || (server && server.date) || new Date().toISOString(),
      views: server ? server.views : 0,
      readMinutes: Math.max(1, Math.round(SAN.toText(data.content).split(' ').length / 200)),
      videos: data.videos.map((u) => ({ url: u })),
    };
    try { localStorage.setItem('aslf_apercu', JSON.stringify(preview)); }
    catch { toast('Impossible d’afficher l’aperçu sur cet appareil.', 'error'); return; }
    window.open('/article.html?apercu=1', '_blank');
  });

  window.addEventListener('beforeunload', (e) => {
    if (!$('#editor').hidden && isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── Démarrage ─────────────────────────────────────────────────────────────
  async function init() {
    try {
      if (id) {
        server = await api('GET', `/api/admin/articles/${encodeURIComponent(id)}`);
        if (server.deletedAt) {
          await api('POST', `/api/admin/articles/${encodeURIComponent(id)}/restaurer`).catch(() => {});
          server.deletedAt = null;
          toast('Cet article était dans la corbeille : il a été remis dans vos articles.');
        }
        fill(server);
        $('#page-title').textContent = 'Modifier l’article';
      } else {
        try { el.author.value = localStorage.getItem('aslf_auteur') || ''; } catch {}
        renderAll();
      }
      savedSnapshot = snapshot();
      $('#loading').hidden = true;
      $('#editor').hidden = false;
      $('#actionbar').hidden = false;
      autosize();
      offerRecovery();
      updateBar();
      if (!id) el.title.focus();
    } catch (e) {
      $('#loading').innerHTML = `<div class="notice notice-error">${icon('triangle-alert')}<div><strong>Impossible d’ouvrir cet article</strong>${esc(e.message)}<div class="actions"><a class="btn btn-secondary" href="/admin/">Retour à la liste des articles</a></div></div></div>`;
    }
  }
  init();
})();
