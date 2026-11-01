#!/usr/bin/env node
/**
 * Change le mot de passe de l'administration depuis le serveur.
 * Usage : npm run mot-de-passe          (le mot de passe est demandé au clavier)
 *    ou : ADMIN_PASSWORD='…' npm run mot-de-passe
 * Toutes les sessions ouvertes sont fermées. Le site doit être redémarré ensuite.
 */
'use strict';
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const env = require('../server/env');

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { rl.output.write(s.startsWith(question) ? s : s.replace(/[^\r\n]/g, '•')); };
    }
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  fs.mkdirSync(env.DATA_DIR, { recursive: true, mode: 0o700 });
  const auth = require('../server/auth');
  auth.init();
  let pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    pw = await ask('Nouveau mot de passe (10 caractères minimum) : ', true);
    const again = await ask('Retapez-le pour confirmer : ', true);
    if (pw !== again) { console.error('Les deux saisies ne correspondent pas. Rien n’a été changé.'); process.exit(1); }
  }
  const problem = auth.passwordProblem(pw);
  if (problem) { console.error(problem); process.exit(1); }
  await auth.setPassword(pw);
  auth.destroyOtherSessions(null);
  await auth.flushAll();
  try { fs.unlinkSync(path.join(env.DATA_DIR, 'MOT-DE-PASSE-INITIAL.txt')); } catch {}
  console.log('Mot de passe enregistré. Redémarrez le site : sudo systemctl restart aslf');
})();
