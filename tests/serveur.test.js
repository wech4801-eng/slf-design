'use strict';
/**
 * Tests de bout en bout : un vrai serveur est lancé sur des données temporaires.
 * Lancement : npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sanitize } = require('../public/assets/sanitize.js');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'mot-de-passe-de-test-1';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aslf-test-'));
let server;
let cookie = '';

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'ASLF' };
async function call(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...H, ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Le serveur n’a pas démarré');
});

after(() => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('les fichiers internes ne sont jamais servis', async () => {
  for (const p of ['/server.js', '/package.json', '/../server.js', '/%2e%2e/server.js', '/.git/config',
    '/data/members.json', '/seed-articles.json', '/server/auth.js', '/.env', '/uploads/../secrets.json']) {
    const r = await fetch(BASE + p);
    assert.equal(r.status, 404, p);
  }
});

test('les pages publiques sont compressées et sécurisées', async () => {
  const r = await fetch(BASE + '/', { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const html = await r.text();
  assert.match(html, /id="aslf-data"/);
  assert.doesNotMatch(html, /fonts\.googleapis/);
});

test('l’administration exige une connexion', async () => {
  assert.equal((await call('GET', '/api/admin/articles')).status, 401);
  const page = await fetch(BASE + '/admin/', { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /connexion/);
});

test('connexion : protection CSRF, mauvais puis bon mot de passe', async () => {
  const noHeader = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const foreign = await call('POST', '/api/login', { password: PASSWORD }, { Origin: 'https://exemple-malveillant.fr' });
  assert.equal(foreign.status, 403);
  assert.equal((await call('POST', '/api/login', { password: 'faux' })).status, 401);
  const ok = await call('POST', '/api/login', { password: PASSWORD });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  cookie = set.split(';')[0];
});

test('article : brouillon invisible, publication, filtre HTML, corbeille', async () => {
  const created = await call('POST', '/api/admin/articles', {
    title: 'Test <b>article</b>', status: 'brouillon', section: 'diplomatie',
    content: '<p onclick="x()">Bonjour<script>alert(1)</script></p><img src="javascript:alert(1)">',
  });
  assert.equal(created.status, 201);
  const a = created.json;
  assert.equal(a.title, 'Test article');
  assert.equal(a.content, '<p>Bonjour</p>');
  assert.equal((await fetch(`${BASE}/api/articles/${a.id}`)).status, 404, 'un brouillon ne doit pas être public');

  const pub = await call('PUT', `/api/admin/articles/${a.id}`, { ...a, status: 'publié' });
  assert.equal(pub.json.isPublic, true);
  const page = await (await fetch(`${BASE}/article.html?id=${a.slug}`)).text();
  assert.match(page, /<title>Test article · ASLF<\/title>/);

  const v1 = await call('POST', `/api/articles/${a.id}/vue`);
  const v2 = await call('POST', `/api/articles/${a.id}/vue`);
  assert.equal(v1.json.views, 1);
  assert.equal(v2.json.views, 1, 'une même personne ne compte qu’une vue');

  await call('DELETE', `/api/admin/articles/${a.id}`);
  assert.equal((await fetch(`${BASE}/api/articles/${a.id}`)).status, 404, 'un article à la corbeille disparaît du site');
  await call('POST', `/api/admin/articles/${a.id}/restaurer`);
  assert.equal((await fetch(`${BASE}/api/articles/${a.id}`)).status, 200);
});

test('publication programmée', async () => {
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const r = await call('POST', '/api/admin/articles', { title: 'Plus tard', status: 'planifié', publishAt: future });
  assert.equal(r.json.status, 'planifié');
  assert.equal(r.json.isPublic, false);
  const past = await call('POST', '/api/admin/articles', { title: 'Déjà passé', status: 'planifié', publishAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(past.json.isPublic, true);
});

test('photos : seules les vraies images sont acceptées', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const ok = await call('POST', '/api/admin/photos', new Uint8Array(png), { 'Content-Type': 'image/png' });
  assert.equal(ok.status, 201);
  assert.match(ok.json.url, /^\/uploads\/\d{4}\/\d{2}\/[\w-]+\.png$/);
  assert.equal((await fetch(BASE + ok.json.url)).status, 200);
  const bad = await call('POST', '/api/admin/photos', '<script>alert(1)</script>', { 'Content-Type': 'image/png' });
  assert.equal(bad.status, 415);
});

test('formulaire de contact → messages de l’administration', async () => {
  const saved = cookie;
  cookie = '';
  const sent = await call('POST', '/api/contact', { nom: 'Awa', email: 'awa@example.org', sujet: 'adhesion', message: 'Bonjour !' });
  assert.equal(sent.status, 201);
  const robot = await call('POST', '/api/contact', { nom: 'Robot', email: 'r@example.org', message: 'spam', site: 'http://spam' });
  assert.equal(robot.status, 200);
  cookie = saved;
  const list = (await call('GET', '/api/admin/messages')).json;
  assert.equal(list.length, 1, 'le message du robot est ignoré');
  assert.equal(list[0].sujetLabel, 'Adhésion');
});

test('membres et sauvegarde ZIP', async () => {
  assert.equal((await call('POST', '/api/admin/membres', { prenom: 'Ali', email: 'pas-un-email' })).status, 400);
  assert.equal((await call('POST', '/api/admin/membres', { prenom: 'Ali', nom: 'Hassan', cotisation: 'À jour' })).status, 201);
  const zip = await fetch(BASE + '/api/admin/sauvegarde', { headers: { Cookie: cookie } });
  assert.equal(zip.status, 200);
  const buf = Buffer.from(await zip.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'en-tête ZIP');
  assert.ok(buf.includes(Buffer.from('members.json')));
});

test('anti-force brute sur la connexion', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/login', { password: 'faux' });
  assert.equal(last.status, 429);
});

test('filtre HTML : attaques connues', () => {
  const cases = [
    '<img src=x onerror=alert(1)>', '<a href="java&#x09;script:alert(1)">x</a>', '<svg><script>alert(1)</script></svg>',
    '<iframe src="https://evil.example"></iframe>', '<scr<script>ipt>alert(1)</script>', '<a href="data:text/html,x">d</a>',
    '<p style="background:url(javascript:x)">t</p>', '<math><mtext><script>alert(1)</script>',
  ];
  for (const c of cases) {
    const out = sanitize(c);
    assert.doesNotMatch(out, /onerror|javascript:|<script|data:text|evil\.example|<svg|<math/i, c);
  }
  assert.equal(sanitize('<p style="text-align:center">ok</p>'), '<p style="text-align:center">ok</p>');
});
