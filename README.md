# Site SLF — Association Somaliland France

Site web officiel de l'**Association Somaliland-France (SLF)**, organisation à
vocation humanitaire et culturelle œuvrant pour la reconnaissance du Somaliland
et l'amitié franco-somalilandaise.

> 🌐 **Production** : https://www.somalilandfrance.org *(à mettre à jour)*

## Pile technique

- HTML5 / CSS3 / JavaScript pur (aucune dépendance npm côté front)
- Backend : **PHP 7.4+** (compatible Hostinger directement)
- Alternative dev : **Node.js** (`node server.js`)
- Stockage : fichiers JSON dans `data/`
- Temps réel : SSE + fallback polling 5 s
- Aucune base de données, aucune dépendance externe

### Déploiement

| Cible | Guide | Cas d'usage |
|---|---|---|
| **Hostinger** | [HOSTINGER.md](HOSTINGER.md) | Production réelle (articles partagés) |
| **GitHub Pages** | [GITHUB.md](GITHUB.md) | Démo gratuite pour montrer à un client |
| **Render/Railway** | (similaire à Hostinger, mais avec `node server.js`) | Production sans PHP |
| **Local dev** | `node server.js` ou `php -S` | Développement |

## Structure du projet

```
.
├── index.html                    # Page d'accueil
├── article.html                  # Vue d'un article (?id=...)
├── news.html                     # Liste des actualités
├── diplomatie.html               # Rubrique Diplomatie
├── association.html              # Présentation de l'association
├── qui-sommes-nous.html          # → comité exécutif
├── notre-but.html                # → mission
├── actions-realisees.html        # → projets concrets
├── bulletin-adhesion.html        # → formulaire d'adhésion
├── appel-cotisation.html         # → cotisation
├── en-images.html                # Galerie photos Lyon (223 images)
├── medias.html                   # Médias (audio/vidéo)
├── radios.html                   # Radios du Somaliland
├── videos.html                   # Vidéos
├── connaitre-somaliland.html     # Histoire & géographie
├── liens-utiles.html             # Liens externes
├── contact.html                  # Coordonnées
│
├── admin-login.html              # Connexion admin
├── admin-dashboard.html          # Tableau de bord (articles)
├── admin-editor.html             # Éditeur d'article
├── admin-medias.html             # Médiathèque (lecture seule)
├── admin-categories.html         # Catégories d'articles
├── admin-membres.html            # Liste des membres
├── admin-parametres.html         # Paramètres
│
├── 404.html                      # Page d'erreur 404
├── favicon.svg                   # Drapeau du Somaliland
├── robots.txt                    # Indexation
├── sitemap.xml                   # Plan du site
├── netlify.toml                  # Configuration Netlify (headers, cache, sécurité)
│
├── admin-auth.js                 # Authentification client (SHA-256 + session)
├── slf-utils.js                  # Utilitaires (échappement, sanitisation, compression)
├── articles-engine.js            # Injection des articles publiés dans les pages rubriques
│
└── images/                       # Toutes les images du site
    └── galerie/                  # 223 photos Lyon
```

## Identifiants administrateur

- **URL** : `/admin-login.html`
- **Identifiant** : `admin`
- **Mot de passe** : `WqTC^+3wjc*v3#Qnbp`

⚠️ **Important** : le hash du mot de passe est stocké en clair côté client
dans `admin-auth.js`. Toute personne déterminée peut le contourner en
modifiant le `localStorage` via les DevTools. Cette authentification
**suffit à dissuader un visiteur lambda** mais **ne remplace pas** une
authentification serveur. Pour une vraie sécurité, voir la section
*Évolutions* ci-dessous.

## Fonctionnalités principales

### Côté public
- Page d'accueil dynamique : hero, actualités, presse externe, mission
- 17 pages de contenu statique
- Galerie photo « En images » avec 223 photos, lightbox + navigation clavier
- Page article dynamique (rendu depuis localStorage)
- Compteur de vues (incrémenté à chaque visite publique)
- Partage Facebook / Twitter / WhatsApp / copie de lien
- Responsive mobile / desktop

### Côté admin
- Dashboard avec compteurs réels (articles publiés, vues, brouillons)
- Éditeur WYSIWYG (gras, italique, listes, citations, images inline, vidéos)
- Upload d'image avec **compression automatique** (max 1,5 Mo en base64)
- Galerie multi-images par article + vidéos YouTube/Vimeo/locale
- Aperçu avant publication
- Gestion des membres, catégories, paramètres
- SEO par article (slug, méta description, titre Google)

### Sécurité
- Hashage SHA-256 du mot de passe (jamais en clair dans le source)
- Jeton de session aléatoire 256 bits avec expiration 8 h
- Échappement HTML de tous les contenus utilisateur
- Sanitisation des URLs (filtrage `javascript:`, `data:text/html`, etc.)
- Sanitisation du HTML stocké (retrait des `<script>`, `on*=`, iframes non-http)
- Validation et compression des fichiers uploadés
- CSP, X-Frame-Options, HSTS configurés dans `netlify.toml`

## Lancer en local

```bash
# Python (le plus simple)
python -m http.server 3456

# OU Node.js
npx serve .

# Puis ouvrir
http://localhost:3456
```

## Déployer en production

### Option A — Netlify (recommandé, gratuit)

1. Créer un compte sur https://netlify.com
2. **Drag & drop** le dossier du site dans l'interface Netlify
3. Le site est en ligne sous un nom du type `https://nom-aleatoire.netlify.app`
4. Paramétrer un nom de domaine personnalisé dans les paramètres du site
5. Le fichier `netlify.toml` configure automatiquement les en-têtes de sécurité

### Option B — Cloudflare Pages (gratuit, très rapide)

1. Créer un compte sur https://pages.cloudflare.com
2. Connecter un dépôt Git ou faire un upload direct
3. Pas de commande de build, dossier de publication : `/`

### Option C — GitHub Pages (gratuit)

1. Pousser le code sur un dépôt GitHub
2. Activer Pages dans Settings → Pages → Source = main branch / root
3. ⚠️ GitHub Pages ne lit pas `netlify.toml` — les en-têtes de sécurité ne
   seront pas appliqués

### Avant de déployer

1. ✅ Remplacer `https://www.somalilandfrance.org` par votre vrai domaine
   dans `sitemap.xml` et `robots.txt`
2. ✅ Vider votre `localStorage` local (DevTools) pour partir d'un état propre
3. ✅ Changer le mot de passe admin (voir section ci-dessous)

## Changer le mot de passe administrateur

Le mot de passe est stocké sous forme de hash SHA-256 dans `admin-auth.js`,
ligne ~25 :

```js
const EXPECTED_PASS_HASH = '012798d1171df5c8c6d7ecf2abb30adfe490d91ea5a029286bbcc67c3bf9b722';
```

Pour générer le hash d'un nouveau mot de passe :

```bash
# Bash / WSL
echo -n 'MON_NOUVEAU_MOT_DE_PASSE' | sha256sum
```

Ou directement dans la console du navigateur :

```js
SLFAuth.sha256('MON_NOUVEAU_MOT_DE_PASSE').then(h => console.log(h));
```

Remplacer la valeur de `EXPECTED_PASS_HASH` par le nouveau hash.

## Données stockées (localStorage)

| Clé                  | Contenu                                            |
| -------------------- | -------------------------------------------------- |
| `slf_admin_session`  | Jeton de session admin (expire après 8 h)          |
| `slf_articles`       | Articles publiés / brouillons                      |
| `slf_members`        | Liste des membres                                  |

⚠️ Les articles sont stockés dans le navigateur de l'admin. Si l'admin change
de navigateur ou efface ses données, les articles sont perdus. Pour une
solution multi-utilisateurs, voir *Évolutions* ci-dessous.

## Limites connues

- **Stockage limité** : ~5 Mo de localStorage. Soit environ 7-10 articles
  avec image de couverture. Les images sont compressées en JPEG ≤ 1,5 Mo.
- **Pas de multi-utilisateurs** : si plusieurs personnes administrent le
  site, chacune a son propre localStorage isolé.
- **Authentification client** : peut être contournée par DevTools.
- **Pas de commentaires** ni de formulaire de contact fonctionnel
  (intentionnellement retirés, nécessitent un backend).

## Évolutions futures recommandées

Pour un site vraiment robuste en production, il faudra à terme :

1. **Backend** (Node.js, Firebase, Supabase) pour :
   - Authentification serveur sécurisée
   - Stockage centralisé des articles
   - Multi-utilisateurs
2. **Service email** (EmailJS, SendGrid, Mailjet) pour :
   - Formulaire de contact fonctionnel
   - Newsletter
3. **CDN images** (Cloudinary, ImageKit) pour :
   - Stockage des grosses images
   - Redimensionnement automatique
   - Plus de limite de quota

## Licence

© 2026 Association Somaliland-France (SLF) — Tous droits réservés.

## Contact

📍 Association Somaliland-France
13 Chemin d'Auguste Renoir, 69120 Vaulx-en-Velin (Lyon)
✉️ aslf.lyon@gmail.com
