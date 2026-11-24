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
  for (const p of ['/app/bootstrap.php', '/app/mot-de-passe-initial.php', '/app/', '/seed-articles.json', '/.htaccess', '/app/.debug']) {
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

test('administration : cycle complet', { skip: skip || (!PASSWORD && 'ASLF_MOT_DE_PASSE non défini') }, async () => {
  const bad = await req('POST', '/api/login', { body: { password: 'mauvais-mot-de-passe' } });
  assert.equal(bad.status, 401);
  const login = await req('POST', '/api/login', { body: { password: PASSWORD } });
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

  // Article : brouillon nettoyé, invisible du public
  const created = await req('POST', '/api/admin/articles', { body: {
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

  // Photo utilisée : suppression refusée
  assert.equal((await req('DELETE', '/api/admin/photos?url=' + encodeURIComponent(up.data.url))).status, 409);

  // Corbeille, restauration, suppression définitive
  assert.equal((await req('DELETE', '/api/admin/articles/' + a.id)).status, 200);
  assert.ok((await req('GET', '/api/admin/articles')).data.find((x) => x.id === a.id).deletedAt);
  assert.equal((await req('POST', '/api/admin/articles/' + a.id + '/restaurer')).status, 200);
  assert.equal((await req('DELETE', '/api/admin/articles/' + a.id + '?definitif=1')).status, 200);
  assert.equal((await req('GET', '/api/admin/articles/' + a.id)).status, 404);
  assert.equal((await req('DELETE', '/api/admin/photos?url=' + encodeURIComponent(up.data.url))).status, 200);

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
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  cookie = savedCookie2;
  const msgs = (await req('GET', '/api/admin/messages')).data;
  const msg = msgs.find((x) => x.nom === 'Test automatique');
  assert.ok(msg && msg.lu === false && msg.sujetLabel === 'Demande d’information');
  assert.equal((await req('PUT', '/api/admin/messages/' + msg.id, { body: { lu: true } })).status, 200);
  assert.equal((await req('DELETE', '/api/admin/messages/' + msg.id)).status, 200);

  // État, sauvegarde, mot de passe
  const etat = (await req('GET', '/api/admin/etat')).data;
  assert.ok(etat.articles.enLigne >= 1 && etat.version);
  const zip = await fetch(BASE + '/api/admin/sauvegarde', { headers: { Cookie: cookie } });
  assert.equal(zip.status, 200);
  const buf = Buffer.from(await zip.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'fichier ZIP');
  assert.equal((await req('POST', '/api/admin/mot-de-passe', { body: { current: 'faux', next: 'nouveau-mot-de-passe-long' } })).status, 400);

  assert.equal((await req('POST', '/api/logout')).status, 200);
  assert.equal(cookie, '');
  assert.equal((await req('GET', '/api/admin/articles')).status, 401);
});
