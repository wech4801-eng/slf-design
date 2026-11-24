# Site ASLF — Association Somalilandaise de France

Site de l’**Association Somalilandaise de France (ASLF)** : site public, espace de gestion
pour publier des articles sans connaissances techniques, formulaire de contact, liste des membres.

- **Hébergé chez Hostinger** (offre Premium Web Hosting de l’association) : PHP 8 + SQLite, aucune dépendance.
- **Tout est stocké sur le serveur** : articles, photos, membres et messages vivent dans le dossier
  `aslf-data/` du serveur, jamais dans le navigateur des visiteurs.
- **Autonome** : copie de la base chaque jour (30 jours gardés), corbeille vidée après 30 jours,
  sauvegarde complète téléchargeable depuis l’espace de gestion.
- **Rapide et référencé** : articles intégrés directement dans les pages, sitemap automatique,
  métadonnées de partage par article.

Adresse définitive : <https://www.asso-slf.org> (bascule du domaine décrite dans le guide).

## Mettre en ligne

Tout est décrit dans **[DEPLOIEMENT-HOSTINGER.md](DEPLOIEMENT-HOSTINGER.md)**.

Pour les bénévoles qui publient des articles : **[GUIDE-ADMINISTRATION.md](GUIDE-ADMINISTRATION.md)**.

## Organisation du code

```
public/                  Tout ce qui est envoyé sur Hostinger (contenu de public_html)
  index.php              Point d’entrée : API, pages avec articles intégrés, photos, sitemap
  .htaccess              HTTPS, adresse unique www, routage, en-têtes de sécurité, cache
  app/                   Code serveur (jamais accessible depuis le web)
    bootstrap.php        Chemins, base SQLite, réponses HTTP, erreurs
    store.php            Articles, membres, messages, photos, sauvegardes
    auth.php             Mot de passe (password_hash), sessions (cookie HttpOnly), anti-force brute
    api.php              API /api/… (mêmes adresses que l’ancien serveur Node)
    render.php           Pages : articles intégrés, métadonnées, sitemap, robots
    sanitize.php         Filtre HTML des articles (portage de assets/sanitize.js)
    sections.php         Rubriques et thèmes (identiques à assets/config.js)
  *.html                 Pages du site
  assets/site.js         Script unique du site public (articles, menu, partage, contact)
  assets/sanitize.js     Filtre HTML de l’éditeur (collage depuis Word, aperçu)
  assets/config.js       Rubriques et thèmes des articles
  admin/                 Espace de gestion
  seed-articles.json     Articles d’origine, importés au tout premier démarrage
scripts/paquet-hostinger.py   Fabrique dist/aslf-site.zip à envoyer sur Hostinger
tests/                   Tests : cohérence locale + bout en bout sur le site en ligne
```

## Données (sur le serveur, à côté de public_html)

```
domains/<domaine>/aslf-data/
  aslf.sqlite            Base : articles, membres, messages, sessions
  uploads/AAAA/MM/       Photos envoyées depuis l’espace de gestion
  sauvegardes/           Une copie de la base par jour, 30 jours
  erreurs.log            Journal des erreurs serveur
```

Les photos et vidéos des événements (388 Mo) sont à part, dans `domains/<domaine>/medias/`
(dossier local `medias/`, hors Git, envoyé avec `scripts/envoyer-medias.py`).

Ces dossiers sont en dehors de `public_html` : il n’est pas accessible depuis le web et un nouveau
déploiement du site ne l’efface pas.

## Tests

```powershell
node --test "tests/*.test.mjs"
```

Sans variable d’environnement, seuls les tests locaux tournent. Pour tester le site en ligne :

```powershell
$env:ASLF_URL = "https://www.asso-slf.org"; $env:ASLF_MOT_DE_PASSE = "…"; node --test "tests/*.test.mjs"
```

Les tests de bout en bout créent un article, un membre, un message et une photo de test, puis les suppriment.
