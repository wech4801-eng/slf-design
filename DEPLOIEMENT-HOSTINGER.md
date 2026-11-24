# Déploiement sur Hostinger

Le site tourne sur l’offre **Premium Web Hosting** de l’association (compte Hostinger
`somalilande.france@gmail.com`, payé jusqu’au 24/11/2030), en PHP 8 + SQLite.
Cette offre n’exécute pas Node.js : c’est pour cela que le serveur est écrit en PHP.

| Élément | Valeur |
|---|---|
| Site Hostinger | `skilled-lightpink-jackal-34.hostingersite.com` (adresse provisoire) |
| Compte d’hébergement | `u758983045`, data center France |
| Dossier du site | `domains/<domaine>/public_html` |
| Données | `domains/<domaine>/aslf-data` (hors de `public_html`, jamais effacé par un déploiement) |
| Photos et vidéos des événements | `domains/<domaine>/medias/ASLF-medias` (hors de `public_html`, servies à l’adresse `/medias/…`) |
| Espace de gestion | `https://<domaine>/admin/` |

## Mettre à jour le site

1. Fabriquer l’archive :
   ```powershell
   python scripts/paquet-hostinger.py
   ```
   Elle est créée dans `dist/aslf-site.zip`. Le mot de passe initial de l’administration est lu dans
   `data/ACCES-ADMIN.txt` (jamais commité) ; seule son empreinte part dans l’archive.
2. L’envoyer : hPanel → le site → **Gestionnaire de fichiers** → `public_html` → téléverser l’archive puis
   l’extraire en remplaçant les fichiers. Avec l’API Hostinger (extension Claude) :
   `hosting_files_generate-upload-url` (envoi TUS de `aslf-site.zip`) puis
   `hosting_websites_deploy-static-site-archive` avec `archive_path: aslf-site.zip`.
   Ce déploiement remplace tout `public_html` ; les données de `aslf-data` ne sont pas touchées.
3. Vérifier :
   ```powershell
   $env:ASLF_URL = "https://www.asso-slf.org"; $env:ASLF_MOT_DE_PASSE = "…"; node --test "tests/*.test.mjs"
   ```

Mode mise au point : `python scripts/paquet-hostinger.py --debug` ajoute le détail technique aux messages
d’erreur. Ne jamais le laisser en production.

## Photos et vidéos des événements

Livrées le 31/10/2026 (`ASLF-livraison-developpeur.zip`, brief `BRIEF-DEVELOPPEUR.md`) et intégrées ainsi :

| Contenu | Page | Détail |
|---|---|---|
| Galerie « Nos événements en images » | `en-images.html` | Composant `galerie-a-coller.html` fourni, `data-base="/medias/ASLF-medias/"`, un onglet par album, film en tête de chaque album |
| Film souvenir de la Fête nationale | `index.html` (section « Retour en images ») | Vidéo d’accueil, lecture au clic, `preload="none"` |
| Actualités du Somaliland (15 articles, 27/10/2026) | `news.html` | Bloc `#slf-actus` fourni, sous les articles de l’association |
| Livre « Somaliland — Histoire d’une nation, mémoire d’un génocide » | `connaitre-somaliland.html` | `documents/somaliland-histoire-et-memoire.pdf`, bouton « Télécharger le livre » |

Les médias (388 Mo, 236 fichiers) ne sont **pas** dans Git ni dans l’archive du site : ils sont dans le dossier
local `medias/` (gitignoré) et envoyés une fois sur Hostinger, dans `domains/<domaine>/medias/`, avec :
```powershell
$env:HOSTINGER_TUS_URL = "…/api/tus/public_html"; $env:HOSTINGER_X_AUTH = "…"; $env:HOSTINGER_X_AUTH_REST = "…"
python scripts/envoyer-medias.py
```
(identifiants donnés par `hosting_files_generate-upload-url`). PHP les sert avec la lecture par morceaux (Range)
nécessaire aux vidéos ; le CDN d’Hostinger les met en cache 30 jours. Hostinger désactive `symlink()`,
d’où ce relais PHP.

**Dates encore à fournir par l’association** (rien n’est affiché en attendant) : la soirée de la Fête nationale
(probablement le 31 mai 2025), la cérémonie à l’Arc de Triomphe, le jour de la célébration de janvier 2026.
Pour les ajouter : modifier le champ `sous_titre` de l’album dans `public/en-images.html`, puis redéployer.

## Brancher le domaine asso-slf.org

Aujourd’hui (24/11/2026), `asso-slf.org` est enregistré chez **Scaleway** (verrouillé, expire le 15/05/2027)
et pointe vers **o2switch**, qui héberge l’ancien site Joomla **et les e-mails** de l’association
(champ MX et SPF chez o2switch). Ordre à respecter pour ne rien casser :

1. **Recenser les e-mails** @asso-slf.org dans le cPanel o2switch (boîtes, redirections) et les recréer
   chez Hostinger (hPanel → Emails), ou noter les enregistrements MX à conserver.
2. **Sauvegarder le Joomla** depuis o2switch (fichiers + base) avant toute résiliation.
3. **Ajouter le domaine au site** : hPanel → le site → **Connecter un nom de domaine** → `asso-slf.org`.
   Vérifier ensuite que `aslf-data` se trouve bien à côté du nouveau `public_html` (sinon l’y déplacer
   avec le Gestionnaire de fichiers).
4. **Transférer le domaine** de Scaleway vers Hostinger (transfert gratuit inclus dans l’offre) :
   chez Scaleway, retirer le verrou et récupérer le code de transfert (EPP), puis hPanel → Noms de domaine →
   Transferts. Compter 5 à 7 jours.
   *Plus rapide en attendant :* chez Scaleway, remplacer les serveurs DNS par ceux indiqués par hPanel,
   **après** avoir recréé les enregistrements e-mail chez Hostinger.
5. **HTTPS** : hPanel → Sécurité → SSL, installer le certificat gratuit pour `asso-slf.org` et `www`.
6. Le `.htaccess` redirige déjà `asso-slf.org` vers `https://www.asso-slf.org`. Le fichier `robots.txt`
   autorise le référencement dès que le site répond sur asso-slf.org (il l’interdit sur l’adresse provisoire).
7. Déclarer `https://www.asso-slf.org/sitemap.xml` dans Google Search Console.

## Sauvegardes

- **Automatiques** : une copie de la base par jour dans `aslf-data/sauvegardes/` (30 jours), plus les
  sauvegardes hebdomadaires d’Hostinger (hPanel → Sauvegardes).
- **Manuelles** : espace de gestion → Réglages → « Télécharger une sauvegarde complète » (ZIP : articles,
  membres et messages en JSON, base complète `aslf.sqlite`, photos).

## Restaurer une sauvegarde

1. hPanel → Gestionnaire de fichiers → `domains/<domaine>/aslf-data/`.
2. Renommer `aslf.sqlite` en `aslf-ancienne.sqlite` (et supprimer `aslf.sqlite-wal` / `aslf.sqlite-shm` s’ils existent).
3. Déposer à la place la copie voulue (`sauvegardes/aslf-AAAA-MM-JJ.sqlite` ou `aslf.sqlite` du ZIP),
   renommée en `aslf.sqlite`. Pour les photos, recopier le dossier `uploads/` du ZIP.

## Mot de passe de l’administration

- Il se change dans l’espace de gestion → **Réglages** (les autres appareils sont alors déconnectés).
- **Oublié ?** hPanel → Gestionnaire de fichiers → dans `aslf-data/`, créer un fichier vide nommé
  `REINITIALISER-MOT-DE-PASSE`. À la connexion suivante, le mot de passe initial (celui de
  `data/ACCES-ADMIN.txt`) redevient valable et le fichier est supprimé automatiquement.
  Changer ensuite le mot de passe dans Réglages.
- 10 essais ratés en 15 minutes bloquent temporairement l’adresse IP concernée.

## En cas de problème

- Journal des erreurs : `aslf-data/erreurs.log`.
- État du site : espace de gestion → Réglages → « État du site » (version, PHP, SQLite, place libre).
- Santé : `https://<domaine>/api/health` doit répondre `{"ok":true,…}`.
