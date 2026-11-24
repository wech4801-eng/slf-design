/**
 * ASLF — Cohérence entre le navigateur et le serveur (sans réseau).
 *   - les rubriques et thèmes de public/assets/config.js et public/app/sections.php sont identiques ;
 *   - le filtre HTML de l'éditeur (sanitize.js) bloque les attaques courantes.
 * Usage : node --test "tests/*.test.mjs"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('../public/assets/config.js');
const { sanitize, toText } = require('../public/assets/sanitize.js');
const php = readFileSync(new URL('../public/app/sections.php', import.meta.url), 'utf8');

const phpList = (name) => {
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(php)[1];
  return [...block.matchAll(/\[([^\]]+)\]/g)].map((m) => Object.fromEntries(
    [...m[1].matchAll(/'(\w+)'\s*=>\s*'([^']*)'/g)].map((x) => [x[1], x[2]])));
};

test('rubriques identiques côté navigateur et serveur', () => {
  assert.deepEqual(phpList('SECTIONS'), config.SECTIONS.map(({ key, label, page }) => ({ key, label, page })));
});

test('thèmes identiques côté navigateur et serveur', () => {
  assert.deepEqual(phpList('CATEGORIES'), config.CATEGORIES.map(({ key, label, tone }) => ({ key, label, tone })));
});

test('filtre HTML : attaques bloquées, mise en forme conservée', () => {
  const out = sanitize('<p onclick="x">Salut&nbsp;!</p><script>alert(1)</script><a href="javascript:alert(1)">a</a>'
    + '<img src="x" onerror="alert(1)"><iframe src="https://evil.example"></iframe><h1>T</h1><p>&nbsp;</p>');
  assert.ok(!/script|javascript|onerror|onclick|evil/i.test(out), out);
  assert.match(out, /<h2>T<\/h2>/);
  assert.equal(toText('Bonjour&nbsp;! <p>x</p>'), 'Bonjour ! x');
  assert.ok(!out.includes('<p>&nbsp;</p>'), 'paragraphe vide retiré');
});
