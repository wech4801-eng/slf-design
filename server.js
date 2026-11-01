#!/usr/bin/env node
/**
 * ASLF — Association Somalilandaise de France
 * Démarrage du site : `npm start` (ou `node server.js`).
 * Configuration par variables d'environnement : voir server/env.js et deploy/aslf.env.exemple.
 */
'use strict';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`Node.js 20 ou plus récent est nécessaire (version actuelle : ${process.versions.node}).`);
  process.exit(1);
}

require('./server/index.js').start();
