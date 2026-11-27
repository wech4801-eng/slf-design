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

## Comptes, alertes et adhésion en ligne (Réglages)

- **Plusieurs comptes** : Réglages → « Comptes d’accès ». Chaque personne a son identifiant (pseudo ou e-mail) et son
  mot de passe ; il faut au moins deux comptes pour ne jamais perdre l’accès. Le compte d’origine est `admin`.
- **Mot de passe oublié par tout le monde** : hPanel → Gestionnaire de fichiers → dans `aslf-data/`, créer un fichier vide
  `REINITIALISER-MOT-DE-PASSE`. Tous les comptes sont effacés et l’identifiant `admin` avec le mot de passe initial
  (`data/ACCES-ADMIN.txt`) redevient valable ; recréer ensuite les autres comptes.
- **Alerte e-mail** à chaque message du formulaire de contact (adresse par défaut : somalilande.france@gmail.com),
  bouton « Envoyer un e-mail de test ». Les messages des tests automatiques (`@example.org`) n’en déclenchent pas.
- **HelloAsso et bulletin** : coller les liens des formulaires HelloAsso (adhésion, don) et envoyer le bulletin PDF ;
  les boutons apparaissent alors seuls sur la page « Adhérer / Faire un don ». Vide = rien d’affiché.
- 10 essais ratés en 15 minutes bloquent temporairement l’adresse IP concernée (voir Pare-feu).

## Redirections

Pages regroupées le 28/11/2026 : `qui-sommes-nous`, `notre-but` → `association.html` ; `appel-cotisation` →
`bulletin-adhesion.html` ; `radios` → `medias.html`. Les anciennes adresses du site Joomla (`index.php?option=…`,
`/index.php/…`, `/component/…`) sont redirigées (301) vers la page la plus proche d’après leurs mots, sinon vers l’accueil.

## Pare-feu (« mini fail2ban »)

Le site bloque **temporairement** (jamais définitivement) les adresses IP qui s’acharnent :

| Comportement | Seuil | Blocage |
|---|---|---|
| Mots de passe faux (force brute) | 5 en 15 minutes | 1 heure |
| Robot qui cherche des failles (`wp-login.php`, `xmlrpc.php`, `phpmyadmin`, `.env`…, piège du formulaire de contact) | 3 en 10 minutes | 1 heure |
| Bombardement de requêtes | plus de 180 pages/appels en 1 minute | 30 minutes |

- Un administrateur **connecté** n’est jamais bloqué ; Réglages → **Sécurité** liste les adresses bloquées avec un bouton « Débloquer ».
- **Bloqué soi-même et pas connecté ?** hPanel → Gestionnaire de fichiers → dans `aslf-data/`, créer un fichier nommé
  `DEBLOQUER-TOUT` : à la requête suivante, tous les blocages sont levés et le fichier disparaît. Sinon, attendre (1 h au plus).
- Le serveur voit bien l’adresse réelle de chaque visiteur (vérifié derrière le CDN d’Hostinger : Réglages → État du site).
- Contre une attaque massive venant de milliers d’adresses à la fois, c’est l’infrastructure d’Hostinger (CDN, protection
  réseau) qui protège : ce pare-feu arrête les robots isolés et la force brute.
- Chaque blocage est noté dans `aslf-data/erreurs.log`.

## Documents joints aux articles

PDF, Word, Excel, PowerPoint, OpenOffice, texte (20 Mo maximum) : éditeur d’article → étape 6 → « Des documents à télécharger ».
Rangés dans `aslf-data/fichiers/AAAA/MM/`, listés dans l’admin (page Photos), servis à l’adresse `/fichiers/…` sous leur nom
d’origine, jamais exécutés (type imposé, `nosniff`, CSP `sandbox`) et jamais gardés par le CDN (un document retiré cesse
d’être téléchargeable aussitôt). Le contenu est vérifié : un faux PDF ou un `.exe` renommé est refusé.

## En cas de problème

- Journal des erreurs : `aslf-data/erreurs.log`.
- État du site : espace de gestion → Réglages → « État du site » (version, PHP, SQLite, place libre).
- Santé : `https://<domaine>/api/health` doit répondre `{"ok":true,…}`.
