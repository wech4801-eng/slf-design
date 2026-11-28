/**
 * ASLF — Tests de bout en bout du site déployé (Hostinger, PHP + SQLite).
 *
 * Usage (PowerShell) :
 *   $env:ASLF_URL = "https://www.asso-slf.org"; $env:ASLF_MOT_DE_PASSE = "…"; node --test "tests/*.test.mjs"
 * Sans ASLF_MOT_DE_PASSE, seuls les tests publics et de sécurité sont lancés.
 * Les éléments créés pendant les tests (article, membre, message, photo) sont supprimés à la fin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.ASLF_URL || '').replace(/\/+$/, '');
const PASSWORD = process.env.ASLF_MOT_DE_PASSE || '';
const LOGIN = process.env.ASLF_IDENTIFIANT || 'admin';
const skip = !BASE && 'ASLF_URL non défini';

let cookie = '';
async function req(method, path, { body, json = true, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  let payload = raw;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (method !== 'GET') { h['X-Requested-With'] ??= 'ASLF'; h.Origin ??= BASE; }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  const set = res.headers.get('set-cookie');
  if (set && set.startsWith('aslf_session=')) {
    const pair = set.split(';')[0];
    cookie = /=(deleted)?$/.test(pair) || /max-age=0\b/i.test(set) ? '' : pair;
  }
  const type = res.headers.get('content-type') || '';
  const data = json && type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, data };
}
const pageData = (html) => JSON.parse(/<script id="aslf-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);

// Petite image PNG 16×16 valide
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNk+M9AEmAiTfmohlENQ0kDAOIoAR+8DdRoAAAAAElFTkSuQmCC', 'base64');

test('public : santé, accueil, actualités', { skip }, async () => {
  assert.equal((await req('GET', '/api/health')).data.ok, true);
  const home = await req('GET', '/');
  assert.equal(home.status, 200);
  const d = pageData(home.data);
  assert.ok(d.total >= 1, 'des articles publiés');
  assert.ok(d.articles.length <= 6);
  assert.ok(!home.data.includes('aslf-france.org'));
  const news = await req('GET', '/news.html');
  assert.equal(pageData(news.data).articles.length, Math.min(24, d.total));
  const api = await req('GET', '/api/articles?limit=2');
  assert.equal(api.data.articles.length, Math.min(2, d.total));
});

test('public : page article, métadonnées, 404', { skip }, async () => {
  const first = (await req('GET', '/api/articles?limit=1')).data.articles[0];
  const page = await req('GET', '/article.html?id=' + encodeURIComponent(first.slug));
  assert.equal(page.status, 200);
  assert.equal(pageData(page.data).article.id, first.id);
  assert.match(page.data, new RegExp(`<meta property="og:url" content="[^"]*${first.slug}`));
  assert.equal((await req('GET', '/article.html?id=nexiste-pas-du-tout')).status, 404);
  assert.equal((await req('GET', '/page-inconnue')).status, 404);
  assert.equal((await req('GET', '/contact')).status, 200, 'adresse sans .html');
  assert.equal((await req('GET', '/diplomatie.html')).status, 200);
  assert.equal((await req('GET', '/mentions-legales.html')).status, 200);
  const sitemap = await req('GET', '/sitemap.xml');
  assert.match(sitemap.data, /<urlset/);
  assert.ok(sitemap.data.includes(first.slug));
});

test('sécurité : code serveur et données jamais servis', { skip }, async () => {
  for (const p of ['/app/bootstrap.php', '/app/mot-de-passe-initial.php', '/app/', '/seed-articles.json', '/app/.debug']) {
    const r = await req('GET', p);
    assert.ok([403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.ok(!String(r.data).includes('sha256'), `${p} ne doit rien révéler`);
  }
  const admin = await req('GET', '/admin/');
  assert.equal(admin.status, 302);
  assert.match(admin.headers.get('location'), /connexion\.html/);
  assert.equal((await req('GET', '/api/admin/articles')).status, 401);
  assert.equal((await req('POST', '/api/login', { body: { password: 'x' }, headers: { 'X-Requested-With': 'autre' } })).status, 403);
  assert.equal((await req('POST', '/api/login', { body: { password: 'x' }, headers: { Origin: 'https://pirate.example' } })).status, 403);
  const home = await req('GET', '/');
  assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
});

// Recette du brief « Intégration des photos et vidéos » (livraison du 31/10/2026)
test('contenus livrés : galerie, films, actualités, livre', { skip }, async () => {
  const page = (await req('GET', '/en-images.html')).data;
  const base = /id="aslf-galerie"[^>]*data-base="([^"]+)"/.exec(page)[1];
  const files = [...page.matchAll(/"(?:fichier|miniature|apercu)": "([^"]+)"/g)].map((m) => m[1]);
  const count = (re) => files.filter((f) => re.test(f)).length;
  assert.equal(count(/\/videos\/film-/), 6, '6 films');
  assert.equal(count(/\/photos\//), 84, '84 photos');
  assert.equal(count(/\/videos\/(?!film-)/), 28, '28 vidéos');
  assert.ok(!/recu_sur_whatsapp/.test(page), 'date de réception WhatsApp jamais affichée');
  const missing = [];
  for (let i = 0; i < files.length; i += 12) {
    await Promise.all(files.slice(i, i + 12).map(async (f) => {
      const r = await fetch(BASE + base + f, { method: 'HEAD' });
      if (r.status !== 200) missing.push(`${r.status} ${f}`);
    }));
  }
  assert.deepEqual(missing, [], 'tous les médias sont en ligne');
  const film = files.find((f) => f.endsWith('film-fete-nationale-somaliland.mp4'));
  const part = await fetch(BASE + base + film, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(part.status, 206, 'lecture par morceaux (avance rapide, iPhone)');
  assert.equal(part.headers.get('content-type'), 'video/mp4');

  const home = (await req('GET', '/')).data;
  assert.match(home, /film-fete-nationale-somaliland\.mp4/, 'film souvenir en vidéo d’accueil');
  for (const html of [home, page]) {
    for (const tag of html.match(/<video[^>]*>/g) || []) {
      assert.match(tag, /preload="none"/, 'aucune vidéo téléchargée avant le clic');
      assert.ok(!/autoplay/.test(tag), 'pas de lecture automatique');
    }
  }
  const news = (await req('GET', '/news.html')).data;
  assert.match(news, /id="slf-actus"/);
  assert.equal((news.match(/<article data-cat=/g) || []).length, 15, '15 actualités du Somaliland');
  const histoire = (await req('GET', '/connaitre-somaliland.html')).data;
  assert.match(histoire, /documents\/somaliland-histoire-et-memoire\.pdf/);
  const pdf = await fetch(BASE + '/documents/somaliland-histoire-et-memoire.pdf', { method: 'HEAD' });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
});

test('administration : cycle complet', { skip: skip || (!PASSWORD && 'ASLF_MOT_DE_PASSE non défini') }, async () => {
  const bad = await req('POST', '/api/login', { body: { identifiant: LOGIN, password: 'mauvais-mot-de-passe' } });
  assert.equal(bad.status, 401);
  assert.equal((await req('POST', '/api/login', { body: { password: PASSWORD } })).status, 401, 'mot de passe seul : refusé');
  assert.equal((await req('POST', '/api/login', { body: { identifiant: 'pas-le-bon', password: PASSWORD } })).status, 401, 'mauvais identifiant : refusé');
  const login = await req('POST', '/api/login', { body: { identifiant: LOGIN.toUpperCase(), password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.ok(cookie, 'cookie de session reçu');
  assert.equal((await req('GET', '/api/session')).data.connected, true);
  assert.equal((await req('GET', '/admin/')).status, 200);

  // Photo
  const up = await req('POST', '/api/admin/photos', { raw: PNG, headers: { 'Content-Type': 'image/png' } });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.match(up.data.url, /^\/uploads\/\d{4}\/\d{2}\/[\w-]+\.png$/);
  const img = await fetch(BASE + up.data.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await req('POST', '/api/admin/photos', { raw: Buffer.from('<?php echo 1; ?>'), headers: { 'Content-Type': 'image/png' } })).status, 415);

  // Documents joints : vrai PDF accepté, faux PDF et format interdit refusés
  const PDF = Buffer.from(['%PDF-1.4', '1 0 obj<<>>endobj', 'trailer<<>>', '%%EOF', ''].join(String.fromCharCode(10)));
  const doc = await req('POST', '/api/admin/documents', { raw: PDF, headers: { 'Content-Type': 'application/pdf', 'X-Nom-Fichier': encodeURIComponent('Compte rendu AG 2026.pdf') } });
  assert.equal(doc.status, 201, JSON.stringify(doc.data));
  assert.equal(doc.data.name, 'Compte rendu AG 2026.pdf');
  assert.equal((await req('POST', '/api/admin/documents', { raw: Buffer.from('<?php echo 1;'), headers: { 'X-Nom-Fichier': 'faux.pdf' } })).status, 415);
  assert.equal((await req('POST', '/api/admin/documents', { raw: PDF, headers: { 'X-Nom-Fichier': 'virus.exe' } })).status, 415);

  // Article : brouillon nettoyé, invisible du public
  const created = await req('POST', '/api/admin/articles', { body: {
    attachments: [{ url: doc.data.url }, { url: '/fichiers/2026/01/inexistant1234.pdf' }],
    title: 'Test automatique <b>ASLF</b>', status: 'brouillon', section: 'diplomatie', categoryKey: 'diplomatie',
    content: '<p>Bonjour&nbsp;! <script>alert(1)</script><a href="javascript:alert(1)">lien</a><img src="x" onerror="alert(1)"></p><h1>Titre</h1>',
    coverImage: up.data.url, tags: ['test'], videos: ['https://youtu.be/dQw4w9WgXcQ'],
  } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const a = created.data;
  assert.equal(a.title, 'Test automatique ASLF');
  assert.ok(!/script|javascript|onerror/i.test(a.content), a.content);
  assert.match(a.content, /<h2>Titre<\/h2>/);
  assert.equal(a.videos[0].url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(a.isPublic, false);
  assert.equal(a.attachments.length, 1, 'seul le vrai document est gardé');
  const savedCookie = cookie;
  cookie = '';
  assert.equal((await req('GET', '/api/articles/' + a.id)).status, 404);
  assert.equal((await req('GET', '/article.html?id=' + a.slug)).status, 404);
  cookie = savedCookie;
  const draftPage = await req('GET', '/article.html?id=' + a.slug);
  assert.equal(draftPage.status, 200);
  assert.equal(pageData(draftPage.data).draft, true);

  // Publication
  const pub = await req('PUT', '/api/admin/articles/' + a.id, { body: { ...a, status: 'publié' } });
  assert.equal(pub.status, 200);
  assert.equal(pub.data.isPublic, true);
  cookie = '';
  assert.equal((await req('GET', '/api/articles/' + a.slug)).status, 200);
  const view = await req('POST', '/api/articles/' + a.id + '/vue');
  assert.equal(view.data.views, 1);
  assert.equal((await req('POST', '/api/articles/' + a.id + '/vue')).data.views, 1, 'une vue par visiteur');
  cookie = savedCookie;

  // Document visible sur la page publique, téléchargeable, protégé tant qu'il est utilisé
  assert.equal(pageData((await req('GET', '/article.html?id=' + a.slug)).data).article.attachments[0].name, 'Compte rendu AG 2026.pdf');
  const dl = await fetch(BASE + doc.data.url);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition') || '', /Compte%20rendu%20AG%202026\.pdf/);
  assert.match(dl.headers.get('content-security-policy') || '', /sandbox/);
  assert.equal((await req('DELETE', '/api/admin/documents?url=' + encodeURIComponent(doc.data.url))).status, 409);

  // Photo utilisée : suppression refusée
  assert.equal((await req('DELETE', '/api/admin/photos?url=' + encodeURIComponent(up.data.url))).status, 409);

  // Corbeille, restauration, suppression définitive
  assert.equal((await req('DELETE', '/api/admin/articles/' + a.id)).status, 200);
  assert.ok((await req('GET', '/api/admin/articles')).data.find((x) => x.id === a.id).deletedAt);
  assert.equal((await req('POST', '/api/admin/articles/' + a.id + '/restaurer')).status, 200);
  assert.equal((await req('DELETE', '/api/admin/articles/' + a.id + '?definitif=1')).status, 200);
  assert.equal((await req('GET', '/api/admin/articles/' + a.id)).status, 404);
  assert.equal((await req('DELETE', '/api/admin/photos?url=' + encodeURIComponent(up.data.url))).status, 200);
  assert.equal((await req('DELETE', '/api/admin/documents?url=' + encodeURIComponent(doc.data.url))).status, 200);
  assert.equal((await fetch(BASE + doc.data.url)).status, 404, 'document supprimé');

  // Membres
  const m = await req('POST', '/api/admin/membres', { body: { prenom: 'Test', nom: 'Automatique', email: 'test@example.org' } });
  assert.equal(m.status, 201);
  assert.equal((await req('PUT', '/api/admin/membres/' + m.data.id, { body: { ...m.data, ville: 'Lyon' } })).data.ville, 'Lyon');
  assert.equal((await req('POST', '/api/admin/membres', { body: { nom: 'X', email: 'pas-un-email' } })).status, 400);
  assert.equal((await req('DELETE', '/api/admin/membres/' + m.data.id)).status, 200);

  // Formulaire de contact → messages
  const savedCookie2 = cookie;
  cookie = '';
  const sent = await req('POST', '/api/contact', { body: { nom: 'Test automatique', email: 'test@example.org', sujet: 'information', message: 'Message de test automatique.' } });
  cookie = savedCookie2;
  if (sent.status === 429) {
    // Anti-spam : 5 messages par heure et par adresse IP (tests lancés plusieurs fois de suite)
    assert.match(sent.data.error, /plusieurs messages/);
  } else {
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    const msgs = (await req('GET', '/api/admin/messages')).data;
    const msg = msgs.find((x) => x.nom === 'Test automatique');
    assert.ok(msg && msg.lu === false && msg.sujetLabel === 'Demande d’information');
    assert.equal((await req('PUT', '/api/admin/messages/' + msg.id, { body: { lu: true } })).status, 200);
    assert.equal((await req('DELETE', '/api/admin/messages/' + msg.id)).status, 200);
  }

  // État, sauvegarde, mot de passe
  const etat = (await req('GET', '/api/admin/etat')).data;
  assert.ok(etat.articles.enLigne >= 1 && etat.version);
  assert.equal(etat.identifiant, LOGIN);
  assert.equal((await req('POST', '/api/admin/identifiant', { body: { current: 'faux', next: 'autre' } })).status, 400);
  assert.equal((await req('POST', '/api/admin/identifiant', { body: { current: PASSWORD, next: 'avec espace' } })).status, 400);
  const zip = await fetch(BASE + '/api/admin/sauvegarde', { headers: { Cookie: cookie } });
  assert.equal(zip.status, 200);
  const buf = Buffer.from(await zip.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'fichier ZIP');
  assert.equal((await req('POST', '/api/admin/mot-de-passe', { body: { current: 'faux', next: 'nouveau-mot-de-passe-long' } })).status, 400);

  assert.equal((await req('POST', '/api/logout')).status, 200);
  assert.equal(cookie, '');
  assert.equal((await req('GET', '/api/admin/articles')).status, 401);
});

// Pare-feu : blocages temporaires, levés ensuite grâce à la session admin (jamais bloquée)
test('pare-feu : scanneurs et force brute bloqués, déblocage par l’admin', { skip: skip || (!PASSWORD && 'ASLF_MOT_DE_PASSE non défini') }, async () => {
  cookie = '';
  const login = await req('POST', '/api/login', { body: { identifiant: LOGIN, password: PASSWORD } });
  assert.equal(login.status, 200, 'connexion admin préalable');
  const admin = cookie;
  const anon = async (method, path, body) => { cookie = ''; const r = await req(method, path, body ? { body } : {}); cookie = admin; return r; };
  // Débloque et remet à zéro les compteurs de cette machine (adresse vue par le serveur)
  const myIp = (await req('GET', '/api/admin/etat')).data.reseau.ip;
  const unban = async () => {
    for (const b of (await req('GET', '/api/admin/securite')).data) await req('DELETE', '/api/admin/securite?ip=' + encodeURIComponent(b.ip));
    await req('DELETE', '/api/admin/securite?ip=' + encodeURIComponent(myIp));
  };
  await unban();

  // 1. Robot scanneur : 3 chemins piégés → bloqué
  assert.ok([403, 404].includes((await anon('GET', '/.env')).status), '/.env refusé (souvent dès le serveur Hostinger)');
  for (const p of ['/wp-login.php', '/xmlrpc.php', '/phpmyadmin/']) assert.equal((await anon('GET', p)).status, 404, p);
  const blocked = await anon('GET', '/');
  assert.equal(blocked.status, 429, 'adresse bloquée après 3 tentatives de robot');
  assert.match(blocked.data, /temporairement bloqué/);
  assert.ok(+blocked.headers.get('retry-after') <= 3600, 'blocage d’une heure au plus');
  const bans = (await req('GET', '/api/admin/securite')).data;
  assert.equal(bans[0].raison, 'Robot qui cherche des failles');
  assert.equal((await req('GET', '/api/admin/etat')).status, 200, 'l’admin connecté n’est pas bloqué');
  await unban();
  assert.equal((await anon('GET', '/')).status, 200, 'débloqué par l’admin');

  // 2. Force brute : 5 mots de passe faux → bloqué au 5e
  let last;
  for (let i = 1; i <= 5; i++) last = await anon('POST', '/api/login', { identifiant: LOGIN, password: 'essai-faux-' + i });
  assert.equal(last.status, 429, '5e essai raté : adresse bloquée');
  assert.equal((await anon('POST', '/api/login', { identifiant: LOGIN, password: PASSWORD })).status, 429, 'même le bon mot de passe est refusé pendant le blocage');
  assert.equal((await req('GET', '/api/admin/securite')).data[0].raison, 'Trop d’essais de connexion ratés');
  await unban();
  assert.equal((await anon('GET', '/api/health')).status, 200, 'débloqué');
  await req('POST', '/api/logout');
  cookie = '';
});

// Demandes du PDF « Ce qu'il faut retirer et améliorer » (26/11/2026)
test('PDF du 26/11 : retraits, textes, menu, Google', { skip }, async () => {
  const home = (await req('GET', '/')).data;
  assert.ok(!/Livret de bienvenue|livret\//i.test(home), 'plus de livret sur l’accueil');
  assert.ok(!/plus de 30 ans|30\+/.test(home), 'plus de « 30 ans »');
  assert.match(home, /reconnue par Israël depuis le 26 décembre 2025/);
  assert.match(home, /Israël a été le premier État à la lui accorder/);
  assert.match(home, /id="rendez-vous"[\s\S]*?class="rdv"/, 'prochains rendez-vous');
  assert.match(home, /application\/ld\+json/, 'fiche Organisation pour Google');
  assert.ok(!/class="btn-admin"/.test(home), 'bouton admin retiré de l’en-tête');
  assert.match(home, /href="admin\/"[^>]*>Espace de gestion/, 'admin dans le pied de page');
  const nav = /<nav class="nav-desktop"[\s\S]*?<\/nav>/.exec(home)[0];
  assert.equal((nav.match(/class="nav-drop-trigger|<a href="(\.\/|contact\.html)"/g) || []).length, 6, '6 entrées + le bouton Adhérer = 7');
  assert.match(home, /class="btn-adherer"/);
  assert.match(home, /page-maj">Page mise à jour le \d+ \w+/);
  assert.match(home, /og:image" content="[^"]*partage-aslf\.jpg/);
  const art = pageData(home).articles;
  assert.ok(!art.some((a) => /livret/.test(a.id)), 'plus d’article du livret');

  const connaitre = (await req('GET', '/connaitre-somaliland.html')).data;
  assert.ok(!/aucun État|absence de reconnaissance|Seule l'Éthiopie|quatre présidents/.test(connaitre));
  assert.match(connaitre, /six présidents se sont succédé, dont quatre élus au suffrage universel \(2003, 2010, 2017, 2024\)/);
  assert.match(connaitre, /id="livre"/);
  // Chaque page qui a un menu mobile et un pied de page en a aussi les styles (sinon menu ouvert en permanence sur ordinateur)
  for (const p of ['/', '/news.html', '/article.html?id=les-mots-du-president-mr-egal-omar', '/actions-realisees.html', '/mentions-legales.html']) {
    const page = (await req('GET', p)).data;
    if (/id="mobileMenu"/.test(page)) assert.match(page, /\.mobile-menu\s*\{[^}]*display:\s*none/, p + ' : menu mobile fermé par défaut');
    if (/class="footer-top"/.test(page)) assert.match(page, /\.footer-top\s*\{[^}]*display:\s*grid/, p + ' : pied de page en colonnes');
    if (/class="nav-drop-trigger"/.test(page)) assert.match(page, /\.nav-drop-trigger svg\s*\{[^}]*width/, p + ' : flèches du menu');
  }
  const commun = (await req('GET', '/assets/commun.css')).data;
  assert.match(commun, /max-width:\s*1099px[\s\S]*\.hamburger\s*\{\s*display:\s*flex/, 'menu ☰ sur tablette (en-tête trop large sous 1100 px)');
  const contact = (await req('GET', '/contact.html')).data;
  assert.ok(!/facebook\.com|twitter\.com|youtube\.com|Lundi|48 h/.test(contact), 'contact nettoyé');
  const bulletin = (await req('GET', '/bulletin-adhesion.html')).data;
  const lien = /<a href="(\/fichiers\/[^"]+\.pdf)" class="btn-download"[^>]*>[\s\S]*?Télécharger le bulletin/.exec(bulletin);
  if (lien) {
    const pdf = await fetch(BASE + lien[1]);
    assert.equal(pdf.status, 200, 'bulletin PDF téléchargeable');
    assert.match(pdf.headers.get('content-type') || '', /application\/pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.match(bulletin, /Téléchargez le bulletin/);
  } else assert.match(bulletin, /href="contact\.html" class="btn-download"/, 'sans bulletin : nous écrire');
  assert.equal((bulletin.match(/Télécharger le bulletin/g) || []).length, lien ? 1 : 0, 'un seul bouton bulletin');
  assert.ok(!/06 61 64 39 46|33661643946/.test(contact), 'un seul numéro');
  assert.match(contact, /wa\.me\/33664157658/, 'WhatsApp sur le 06 64 15 76 58');
  assert.match(home, /6,2 M/); assert.match(connaitre, /6,2 M/); assert.match(connaitre, /176 120/);
  assert.match((await req('GET', '/mentions-legales.html')).data, /Directeur de la publication : M\. Omar Egal/);
  assert.match(bulletin, /Pourquoi cotiser/);
  const news = (await req('GET', '/news.html')).data;
  assert.ok(!/lemonde\.fr\/blog\/somaliland\/2013|jeuneafrique\.com\/111432/.test(news), 'plus d’articles de 2013');
  assert.ok(news.indexOf('id="slf-actus"') < news.indexOf('id="articles-aslf"'), 'actualités du Somaliland en tête');
  assert.ok(!/<h1 class="page-title">News/.test(news));
  assert.ok(!/Djibouti/.test((await req('GET', '/diplomatie.html')).data), 'plus d’articles de 2008');
  const liens = (await req('GET', '/liens-utiles.html')).data;
  assert.ok(!/moh\.gov\.so|seura\.fi|havoyoco|somalilandiuppsala|somalilandgov\.com|walessomaliland/.test(liens), 'liens morts retirés');
  const videos = (await req('GET', '/videos.html')).data;
  assert.ok(!/<iframe/.test(videos) && /yt-facade/.test(videos), 'YouTube chargé au clic');
  for (const p of ['/qui-sommes-nous.html', '/notre-but.html', '/appel-cotisation.html', '/radios.html', '/index.php?option=com_content&view=article&id=12&Itemid=5', '/index.php/contact']) {
    const r = await req('GET', p);
    assert.equal(r.status, 301, p);
  }
  assert.match((await req('GET', '/index.php/contact')).headers.get('location'), /contact\.html/);
  for (const p of ['/', '/news.html', '/connaitre-somaliland.html', '/liens-utiles.html', '/medias.html', '/videos.html', '/association.html', '/contact.html']) {
    const d = /<meta name="description" content="([^"]*)"/.exec((await req('GET', p)).data)[1];
    assert.ok(d.length >= 120 && d.length <= 160, `${p} : description de ${d.length} caractères`);
  }
  const film = await fetch(BASE + '/medias/ASLF-medias/00-film-souvenir/videos/mobile/film-fete-nationale-somaliland.mp4', { method: 'HEAD' });
  assert.equal(film.status, 200, 'film léger pour téléphone');
  assert.ok(+film.headers.get('content-length') < 3 * 1024 * 1024);
});

test('comptes multiples et réglages d’adhésion', { skip: skip || (!PASSWORD && 'ASLF_MOT_DE_PASSE non défini') }, async () => {
  cookie = '';
  assert.equal((await req('POST', '/api/login', { body: { identifiant: LOGIN, password: PASSWORD } })).status, 200);
  const admin = cookie;
  const comptes = (await req('GET', '/api/admin/comptes')).data;
  assert.ok(comptes.some((c) => c.moi && c.identifiant === LOGIN));
  const login2 = 'test-auto-' + Date.now().toString(36);
  const pw2 = 'Mot-de-passe-test-' + Date.now();
  assert.equal((await req('POST', '/api/admin/comptes', { body: { identifiant: login2, password: pw2, current: 'faux' } })).status, 400);
  const c = await req('POST', '/api/admin/comptes', { body: { identifiant: login2, password: pw2, current: PASSWORD } });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal((await req('POST', '/api/admin/comptes', { body: { identifiant: login2, password: pw2, current: PASSWORD } })).status, 409, 'identifiant unique');
  cookie = '';
  assert.equal((await req('POST', '/api/login', { body: { identifiant: login2, password: pw2 } })).status, 200, 'le 2e compte se connecte');
  assert.equal((await req('GET', '/api/admin/etat')).data.identifiant, login2);
  await req('POST', '/api/logout');
  cookie = admin;
  assert.equal((await req('DELETE', '/api/admin/comptes?id=' + c.data.id)).status, 200);
  cookie = '';
  assert.equal((await req('POST', '/api/login', { body: { identifiant: login2, password: pw2 } })).status, 401, 'compte supprimé');
  cookie = admin;

  const before = (await req('GET', '/api/admin/reglages')).data;
  assert.equal(typeof before.alerteActive, 'boolean');
  assert.equal((await req('PUT', '/api/admin/reglages', { body: { helloassoDon: 'https://pirate.example/don' } })).status, 400, 'lien HelloAsso seulement');
  assert.equal((await req('PUT', '/api/admin/reglages', { body: { helloassoDon: 'https://www.helloasso.com/associations/test/formulaires/1' } })).status, 200);
  assert.match((await req('GET', '/bulletin-adhesion.html')).data, /Faire un don en ligne \(HelloAsso\)/, 'bouton HelloAsso affiché');
  assert.equal((await req('PUT', '/api/admin/reglages', { body: { helloassoDon: before.helloassoDon || '' } })).status, 200);
  assert.ok(!/Faire un don en ligne \(HelloAsso\)/.test((await req('GET', '/bulletin-adhesion.html')).data), 'retiré si vide');
  await req('POST', '/api/logout');
  cookie = '';
});
