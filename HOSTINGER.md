# 🚀 Déploiement sur Hostinger

Ce site est conçu pour fonctionner **directement** sur tous les plans Hostinger
qui supportent **PHP 7.4+** (Premium, Business, Cloud, et même la plupart des
plans Single Web Hosting).

**Aucune configuration spéciale n'est nécessaire**, aucune base de données,
aucune extension PHP exotique. Tout est inclus dans le projet.

---

## ⚡ Mise en ligne en 5 minutes

### Méthode 1 — Upload direct via hPanel (la plus simple)

1. **Connectez-vous à Hostinger** → hPanel
2. **Site Web → Fichiers → Gestionnaire de fichiers**
3. Allez dans le dossier **`public_html`** (ou `domains/votre-domaine.com/public_html`)
4. Sélectionnez TOUT le contenu existant et **supprimez-le** (s'il y a une page par défaut)
5. Cliquez sur **« Importer »** en haut à droite
6. Sélectionnez **TOUS les fichiers** du projet `site-slf-design/` (sauf `node_modules/`, `data/`, `.git/`)
   - Ou créez d'abord un .zip et uploadez-le, puis « Extraire » dans hPanel
7. Vérifiez que ces fichiers sont bien à la racine de `public_html/` :
   ```
   public_html/
     ├── index.html
     ├── api.php
     ├── .htaccess
     ├── slf-db.js
     ├── slf-utils.js
     ├── admin-auth.js
     ├── images/
     │   └── galerie/
     ├── ... (tous les .html)
     └── data/        ← sera créé automatiquement au 1er accès
   ```
8. **Donnez les droits d'écriture au dossier** :
   - Clic droit sur `data` (s'il existe déjà) → **Permissions** → `755`
   - Sinon il sera créé automatiquement par PHP au premier appel API

### Méthode 2 — FTP via FileZilla

1. Récupérez vos identifiants FTP dans hPanel → **Sites web → Comptes FTP**
2. Ouvrez FileZilla, connectez-vous
3. Uploadez tout le contenu de `site-slf-design/` dans `/public_html/`
4. C'est tout.

### Méthode 3 — Git (auto-deploy)

Si votre plan Hostinger inclut **Git** :

1. hPanel → **Sites web → Git** → **Créer un dépôt**
2. URL du dépôt : votre URL GitHub
3. Branche : `main`
4. Dossier de déploiement : `/public_html`
5. Activez le **déploiement automatique** : à chaque `git push`, Hostinger met le site à jour.

---

## 🔐 Sécuriser le mot de passe admin

Par défaut, le mot de passe admin est `WqTC^+3wjc*v3#Qnbp`. **Changez-le avant la production** :

### Option A — Variable d'environnement (recommandé)

1. hPanel → **Avancé → Variables PHP** (ou « PHP Configuration »)
2. Ajoutez : `ADMIN_PASS` = `votre_nouveau_mot_de_passe`
3. Sauvegardez. Le site utilise automatiquement la nouvelle valeur.

### Option B — Édition directe du fichier

1. Gestionnaire de fichiers → ouvrir `api.php`
2. Ligne 23 : remplacer `WqTC^+3wjc*v3#Qnbp` par votre mot de passe
3. **Important** : modifiez aussi le hash dans `admin-auth.js` pour l'authentification client :
   - Calculez le SHA-256 du nouveau mot de passe : https://emn178.github.io/online-tools/sha256.html
   - Remplacez la valeur de `EXPECTED_PASS_HASH` (ligne ~25 de `admin-auth.js`)

---

## ✅ Vérifier que tout fonctionne

Après upload, ouvrez ces URLs (remplacez `votre-domaine.com`) :

| URL | Doit afficher |
|---|---|
| `https://votre-domaine.com/` | La page d'accueil |
| `https://votre-domaine.com/api/articles` | `[]` (liste vide en JSON) |
| `https://votre-domaine.com/admin-login.html` | Formulaire de connexion |
| `https://votre-domaine.com/en-images.html` | La galerie 223 photos |

Si `/api/articles` affiche du code PHP brut, alors :
- PHP n'est pas activé sur votre plan (rare)
- Le fichier `.htaccess` n'a pas été uploadé (caché par défaut dans certains FTP)
- → Activez « Afficher les fichiers cachés » dans FileZilla et ré-uploadez

---

## 🗄 Sauvegarde des données

Les articles et membres sont stockés dans `/public_html/data/` :
- `articles.json`
- `members.json`
- `tokens.json` (sessions admin, peut être supprimé)

**Pour sauvegarder** : téléchargez régulièrement le dossier `data/` via FTP.

**Pour restaurer sur un autre serveur** : uploadez le dossier `data/` à la racine.

Hostinger fait aussi des **sauvegardes automatiques** que vous pouvez restaurer
depuis hPanel → **Sites web → Sauvegardes**.

---

## 📊 Espace disque et trafic

| Élément | Volume |
|---|---|
| Code source | ~600 Ko |
| 223 photos galerie | ~11 Mo |
| Polices Google | chargées depuis Google (CDN) |
| Stockage articles | quelques Ko par article (texte) + image compressée (~500 Ko max) |
| **Total initial** | **~12 Mo** |

Largement compatible avec **tous les plans Hostinger** (à partir du plan Single qui offre 30 Go).

---

## 🐛 Dépannage

### « Internal Server Error 500 »
- Vérifiez les droits du dossier `data/` (doit être `755`)
- Vérifiez que `api.php` n'est pas corrompu (re-uploader)
- Consultez les logs : hPanel → **Avancé → Journaux d'erreurs**

### « API_KO » ou pas de chargement d'articles
- Ouvrez la console navigateur (F12)
- Si erreur 404 sur `/api/articles` → le `.htaccess` n'est pas appliqué
  - Vérifier : hPanel → Sites web → **Apache** → mod_rewrite activé
  - Ou éditer `.htaccess` et vérifier qu'il n'a pas été renommé

### Le mode temps réel ne fonctionne pas (SSE)
- **Normal** sur le shared hosting Hostinger (PHP-FPM coupe les connexions longues)
- Le code bascule automatiquement en **polling toutes les 5 secondes** → vous verrez
  les nouveaux articles dans les 5 s suivant leur publication.

### Mot de passe admin oublié
- hPanel → Gestionnaire de fichiers → ouvrir `api.php`
- Ligne 23 : visible en clair (`define('ADMIN_PASS', ...)`)

---

## 🌐 Domaine personnalisé

1. hPanel → **Domaines → Domaine principal**
2. Pointez votre domaine sur le site (Hostinger le configure automatiquement)
3. Activez le **SSL gratuit** (hPanel → SSL → installer le certificat)
4. Modifiez `sitemap.xml` et `robots.txt` pour utiliser votre vrai domaine

---

## 📞 Support

- Hostinger : support 24/7 en français via le chat dans hPanel
- Documentation du site : `README.md`
