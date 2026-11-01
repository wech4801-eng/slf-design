# Site ASLF — Association Somalilandaise de France

Site de l’**Association Somalilandaise de France (ASLF)** : site public, espace de gestion
pour publier des articles sans connaissances techniques, formulaire de contact, liste des membres.

- **Aucune dépendance** : Node.js ≥ 20 suffit (`npm install` inutile).
- **Autonome** : sauvegardes quotidiennes, redémarrage automatique, HTTPS automatique (Caddy).
- **Rapide** : pages compressées, articles injectés côté serveur, polices et images optimisées.

## Démarrer en local

```bash
npm start
```

Puis ouvrir <http://localhost:3456>. Au premier lancement, un mot de passe d’administration
est généré dans `data/MOT-DE-PASSE-INITIAL.txt` (ou choisi avec `npm run mot-de-passe`).
L’espace de gestion est à l’adresse `/admin/`.

## Mettre en ligne

Tout est décrit dans **[DEPLOIEMENT-VPS.md](DEPLOIEMENT-VPS.md)** : une seule commande installe
le site sur un VPS Debian ou Ubuntu.

Pour les bénévoles qui publient des articles : **[GUIDE-ADMINISTRATION.md](GUIDE-ADMINISTRATION.md)**.

## Organisation du code

```
server.js              Démarrage
server/
  index.js             Serveur HTTP : pages, API, cache, compression, sécurité
  store.js             Articles, membres, messages, photos (fichiers JSON écrits de façon atomique)
  auth.js              Mot de passe (scrypt), sessions (cookie HttpOnly), anti-force brute
  zip.js               Archive de sauvegarde téléchargeable
  env.js               Configuration (variables d’environnement)
public/                Tout ce qui est servi aux visiteurs
  *.html               Pages du site
  assets/site.js       Script unique du site public (articles, menu, partage, contact)
  assets/sanitize.js   Filtre HTML des articles (partagé serveur / éditeur)
  assets/config.js     Rubriques et thèmes des articles
  admin/               Espace de gestion (articles, messages, membres, photos, réglages)
scripts/mot-de-passe.js  Changer le mot de passe depuis le serveur
deploy/                Installation et mise à jour sur VPS (systemd, Caddy, surveillance)
tests/                 Tests de bout en bout : `npm test`
```

Les données vivent hors du code, dans `data/` en local et dans `/var/lib/aslf` sur le serveur :
`articles.json`, `members.json`, `messages.json`, `uploads/` (photos), `backups/` (30 jours).

## Démo GitHub Pages

Chaque envoi sur `main` publie une démo statique du site public (sans administration ni
formulaire de contact) : <https://wech4801-eng.github.io/slf-design/>.

## Licence

© Association Somalilandaise de France (ASLF) — Tous droits réservés.
21 Robert Desnos, 69120 Vaulx-en-Velin — somalilande.france@gmail.com
