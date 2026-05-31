# 🐙 Déploiement sur GitHub Pages

Idéal pour **montrer le site à un client**, pas pour la production réelle.

> **⚠️ Limitation importante** : GitHub Pages ne sert que des fichiers statiques.
> Le backend (`api.php` / `server.js`) **ne s'exécute pas**. Conséquence : les
> articles créés via l'admin restent stockés dans le navigateur (mode démo).
> Pour la vraie production avec articles partagés, utiliser **Hostinger**
> (voir [HOSTINGER.md](HOSTINGER.md)).

---

## 🚀 Mise en ligne en 5 minutes

### Étape 1 — Créer le dépôt GitHub

1. Aller sur https://github.com et se connecter
2. Cliquer **+ → New repository**
3. Nom du dépôt : `slf-design` (ou autre)
4. Visibilité : **Public** (Pages gratuit nécessite public ; Private = abonnement Pro)
5. ✅ « Add a README » non coché (on a déjà le nôtre)
6. Cliquer **Create repository**

### Étape 2 — Pousser le code

Dans le terminal, dans le dossier `site-slf-design/` :

```bash
git remote add origin https://github.com/VOTRE_PSEUDO/slf-design.git
git branch -M main
git push -u origin main
```

GitHub vous demandera vos identifiants. Pour le mot de passe, utilisez un
**token personnel** : https://github.com/settings/tokens/new (cocher `repo`).

### Étape 3 — Activer GitHub Pages

1. Dans votre dépôt sur GitHub → **Settings → Pages**
2. **Source** : sélectionner **GitHub Actions**
3. (Le workflow `.github/workflows/deploy-pages.yml` est déjà inclus dans le projet)
4. Aller dans l'onglet **Actions** : le déploiement démarre automatiquement
5. Attendre la fin (1-2 minutes), puis le site est en ligne sur :
   ```
   https://VOTRE_PSEUDO.github.io/slf-design/
   ```

À chaque `git push`, le site est automatiquement redéployé.

---

## 🌐 Domaine personnalisé (optionnel)

Si vous avez un nom de domaine (acheté sur OVH, Gandi, Hostinger…) :

1. Settings → Pages → **Custom domain** → entrer `votre-domaine.com`
2. Chez votre registrar, créer un enregistrement DNS :
   - Type : **CNAME**
   - Nom : `www` (ou `@` selon le registrar, voir docs GitHub)
   - Cible : `VOTRE_PSEUDO.github.io`
3. Attendre la propagation DNS (5 min à 24 h)
4. ✅ Cocher **Enforce HTTPS** (certificat gratuit auto)

Le projet contient déjà tout pour faire fonctionner un domaine custom — vous
n'avez qu'à le configurer côté DNS.

---

## ⚙️ Ce qui fonctionne / ne fonctionne pas

| Fonctionnalité | GitHub Pages |
|---|---|
| Page d'accueil, news, articles statiques | ✅ |
| Galerie 223 photos | ✅ |
| Navigation, header, footer, breadcrumbs | ✅ |
| Pages association (Qui sommes-nous, etc.) | ✅ |
| Page article (avec ID) | ✅ |
| Recherche / partage / lightbox | ✅ |
| **Login admin** | ✅ (le client peut tester) |
| **Création d'article en admin** | ⚠️ stocké dans **ce navigateur uniquement** |
| **Publication visible par les visiteurs** | ❌ (chaque navigateur a son propre stockage) |
| **Membres, newsletter, médias** | ⚠️ idem (mono-navigateur) |

Une **bannière jaune discrète** apparaît automatiquement en bas des pages admin
pour rappeler ce point.

---

## 🔄 Pour passer en production réelle après la démo

Une fois la démo validée par le client, suivre [HOSTINGER.md](HOSTINGER.md)
pour la vraie mise en ligne avec articles partagés.

Aucun changement de code — c'est le **même projet** qui marche partout, juste
le backend qui change selon l'hébergeur.

---

## 🛠 Dépannage

### Erreur 404 sur le site déployé
- Vérifier que le workflow a réussi dans **Actions** (icône verte ✓)
- L'URL est sensible à la casse : `slf-design` ≠ `SLF-Design`
- Attendre 2-3 minutes après le 1er déploiement (propagation CDN GitHub)

### Le déploiement échoue dans Actions
- Vérifier que **Pages → Source → GitHub Actions** est bien sélectionné
- Cliquer **Re-run all jobs** dans l'onglet Actions

### Les images ne se chargent pas
- Vérifier que le dossier `images/` est bien commité
  ```bash
  git add images/
  git commit -m "Ajouter images"
  git push
  ```

### Le mot de passe admin est visible publiquement
- ⚠️ Sur GitHub Pages, `admin-auth.js` est public (visible par tout le monde).
- Le mot de passe en clair n'y figure PAS (seulement son hash SHA-256),
  mais ce n'est pas un secret réel.
- **Ne pas mettre d'infos sensibles** sur GitHub Pages — c'est une démo.
- Pour de la vraie sécurité : utiliser Hostinger avec variable d'environnement.
