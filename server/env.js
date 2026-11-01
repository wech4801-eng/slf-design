'use strict';
/**
 * Configuration du serveur, lue dans les variables d'environnement
 * (fichier /etc/aslf/aslf.env sur le VPS, voir deploy/).
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|oui)$/i.test(v);
}

const env = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  HOST: process.env.HOST || '127.0.0.1',
  PORT: parseInt(process.env.PORT || '3456', 10),
  // Adresse publique du site, sans « / » final (ex. https://www.aslf-france.org)
  SITE_URL: (process.env.SITE_URL || '').replace(/\/+$/, ''),
  // Derrière Caddy/nginx : faire confiance à X-Forwarded-For / X-Forwarded-Proto
  TRUST_PROXY: bool(process.env.TRUST_PROXY, false),
  // Cookie « Secure » : automatique en HTTPS, forçable ici
  COOKIE_SECURE: process.env.COOKIE_SECURE === undefined ? null : bool(process.env.COOKIE_SECURE, false),
  BACKUP_DAYS: parseInt(process.env.BACKUP_DAYS || '30', 10),
  TRASH_DAYS: parseInt(process.env.TRASH_DAYS || '30', 10),
  DEV: bool(process.env.DEV, false),
};
env.UPLOADS_DIR = path.join(env.DATA_DIR, 'uploads');
env.BACKUPS_DIR = path.join(env.DATA_DIR, 'backups');

// Domaine écrit en dur dans les pages HTML d'origine (remplacé par SITE_URL)
env.ORIGINAL_SITE_URL = 'https://www.aslf-france.org';

module.exports = env;
