'use strict';
/**
 * Authentification de l'administration.
 *
 * - Mot de passe stocké uniquement sous forme d'empreinte scrypt (data/secrets.json).
 * - Session = jeton aléatoire dans un cookie HttpOnly ; le serveur ne garde que
 *   son empreinte SHA-256 (data/sessions.json), valable 30 jours, prolongée à l'usage.
 * - Anti-force brute : 10 essais par quart d'heure et par adresse IP.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('./env');
const { JsonDoc } = require('./store');

const SESSION_DAYS = 30;
const COOKIE = 'aslf_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const secrets = new JsonDoc('secrets.json', () => ({}));
const sessions = new JsonDoc('sessions.json', () => ({}));

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length,
      { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  } catch { return false; }
  return crypto.timingSafeEqual(actual, expected);
}

/** Vérifie la solidité d'un mot de passe ; renvoie un message d'erreur ou null. */
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Le mot de passe doit faire au moins 10 caractères.';
  if (pw.length > 200) return 'Le mot de passe est trop long.';
  if (/^(.)\1+$/.test(pw) || /^(0123456789|azertyuiop|qwertyuiop|motdepasse|password)/i.test(pw)) return 'Ce mot de passe est trop facile à deviner.';
  return null;
}

function setPassword(pw) {
  const problem = passwordProblem(pw);
  if (problem) { const e = new Error(problem); e.status = 400; e.expose = true; throw e; }
  secrets.data.passwordHash = hashPassword(pw);
  secrets.data.updatedAt = new Date().toISOString();
  secrets.save(0);
  return secrets.flush();
}

function hasPassword() { return !!secrets.data.passwordHash; }

// ── Sessions ─────────────────────────────────────────────────────────────────
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.data[sha(token)] = { created: now, seen: now, exp: now + SESSION_DAYS * 86400 * 1000 };
  sessions.save();
  return token;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** Renvoie la clé de session si la requête est authentifiée, sinon null. */
function sessionOf(req) {
  const token = readCookie(req, COOKIE);
  if (!token || token.length > 100) return null;
  const key = sha(token);
  const s = sessions.data[key];
  if (!s) return null;
  const now = Date.now();
  if (now > s.exp) { delete sessions.data[key]; sessions.save(); return null; }
  // Prolongation glissante, écrite au plus une fois par heure
  if (now - s.seen > 3600 * 1000) {
    s.seen = now;
    s.exp = now + SESSION_DAYS * 86400 * 1000;
    sessions.save(2000);
  }
  return key;
}

function destroySession(key) {
  if (key && sessions.data[key]) { delete sessions.data[key]; sessions.save(); }
}

function destroyOtherSessions(keepKey) {
  for (const k of Object.keys(sessions.data)) if (k !== keepKey) delete sessions.data[k];
  sessions.save();
}

function isSecure(req) {
  if (env.COOKIE_SECURE !== null) return env.COOKIE_SECURE;
  if (req.socket.encrypted) return true;
  return env.TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token) {
  const parts = [`${COOKIE}=${token ? encodeURIComponent(token) : ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    token ? `Max-Age=${SESSION_DAYS * 86400}` : 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

// ── Anti-force brute ─────────────────────────────────────────────────────────
const RL_WINDOW = 15 * 60 * 1000;
const RL_MAX = 10;
const attempts = new Map();

/** Minutes d'attente restantes si l'adresse est bloquée, sinon 0. */
function loginBlocked(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < RL_WINDOW);
  if (list.length) attempts.set(ip, list); else attempts.delete(ip);
  if (list.length >= RL_MAX) return Math.max(1, Math.ceil((RL_WINDOW - (now - list[0])) / 60000));
  return 0;
}
function recordFailure(ip) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
  if (attempts.size > 10000) attempts.clear();
}
function clearFailures(ip) { attempts.delete(ip); }

// ── Démarrage ────────────────────────────────────────────────────────────────
function init() {
  secrets.load();
  sessions.load();
  if (!secrets.data || typeof secrets.data !== 'object') secrets.data = {};
  if (!sessions.data || typeof sessions.data !== 'object') sessions.data = {};
  const now = Date.now();
  for (const [k, s] of Object.entries(sessions.data)) if (!s || now > s.exp) delete sessions.data[k];
  sessions.save();

  // Mot de passe initial : variable ADMIN_PASSWORD, sinon mot de passe aléatoire
  if (!hasPassword()) {
    let pw = process.env.ADMIN_PASSWORD;
    let generated = false;
    if (!pw || passwordProblem(pw)) {
      pw = crypto.randomBytes(9).toString('base64url');
      generated = true;
    }
    secrets.data.passwordHash = hashPassword(pw);
    secrets.data.updatedAt = new Date().toISOString();
    secrets.save(0);
    if (generated) {
      const file = path.join(env.DATA_DIR, 'MOT-DE-PASSE-INITIAL.txt');
      fs.writeFileSync(file, `Mot de passe de l'administration ASLF : ${pw}\n` +
        'Changez-le dans « Réglages » après la première connexion, puis supprimez ce fichier.\n', { mode: 0o600 });
      console.warn(`\n[admin] Aucun mot de passe configuré : un mot de passe a été généré dans ${file}\n`);
    }
  }
}

function flushAll() { return Promise.all([secrets.flush(), sessions.flush()]); }

module.exports = {
  init, flushAll, hasPassword, verifyPassword, setPassword, passwordProblem,
  get passwordHash() { return secrets.data.passwordHash; },
  createSession, sessionOf, destroySession, destroyOtherSessions, sessionCookie,
  loginBlocked, recordFailure, clearFailures,
};
