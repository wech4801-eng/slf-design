# Mettre le site ASLF en ligne sur un VPS

Une fois installé, le site fonctionne tout seul :

| Ce qui se passe automatiquement | Comment |
|---|---|
| Le site démarre quand le serveur redémarre | service systemd `aslf` |
| Le site redémarre s’il plante | `Restart=always` |
| Le site est relancé s’il ne répond plus | contrôle toutes les 5 min (`aslf-sante.timer`) |
| Certificat HTTPS obtenu et renouvelé | Caddy (Let’s Encrypt) |
| Sauvegarde des articles, membres et messages | chaque jour, 30 jours conservés |
| Corbeille des articles vidée | après 30 jours |
| Mises à jour de sécurité du système | `unattended-upgrades` |
| Journaux limités en taille | journald 200 Mo, Caddy 5 × 20 Mo |
| Mise à jour du site qui échoue | retour automatique à la version précédente |

## 1. Prérequis

- Un VPS **Debian 12** ou **Ubuntu 22.04/24.04**, 1 Go de mémoire suffit.
- Un nom de domaine dont les enregistrements **A** (et AAAA si IPv6) pointent vers l’adresse
  IP du VPS, pour `www.votre-domaine.org` **et** `votre-domaine.org`.
- Un accès SSH avec un utilisateur qui peut faire `sudo`.

## 2. Installation (10 minutes)

```bash
sudo git clone https://github.com/wech4801-eng/slf-design.git /opt/aslf
sudo bash /opt/aslf/deploy/installer.sh www.aslf-france.org
```

Le script demande de choisir le **mot de passe de l’espace de gestion** (10 caractères minimum),
puis installe tout le reste. À la fin, il affiche les adresses du site.

> Si le dépôt devient privé, utilisez une « clé de déploiement » GitHub en lecture seule
> pour le `git clone`.

### Reprendre des articles existants

Si vous aviez déjà des données (dossier `data/` d’une autre installation, ou une sauvegarde
téléchargée depuis l’espace de gestion), placez-les dans `/opt/aslf/data` **avant** de lancer
l’installation : elles sont copiées automatiquement. Les anciennes photos enregistrées dans
les articles sont converties en vrais fichiers au premier démarrage.

## 3. Mettre à jour le site

Après chaque modification envoyée sur GitHub :

```bash
sudo bash /opt/aslf/deploy/mettre-a-jour.sh
```

Si le site ne répond plus après la mise à jour, le script revient tout seul à la version
précédente. Les données ne sont jamais touchées.

## 4. Opérations courantes

| Besoin | Commande |
|---|---|
| Voir si le site tourne | `systemctl status aslf` |
| Lire les journaux du site | `journalctl -u aslf -n 100` |
| Redémarrer le site | `sudo systemctl restart aslf` |
| Changer le mot de passe (oubli) | `sudo -u aslf env DATA_DIR=/var/lib/aslf node /opt/aslf/scripts/mot-de-passe.js` puis `sudo systemctl restart aslf` |
| Changer le domaine | modifier `/etc/aslf/aslf.env` et `/etc/caddy/Caddyfile`, puis `sudo systemctl restart aslf caddy` |
| Espace disque | `df -h /var/lib/aslf` |

## 5. Sauvegardes

- **Automatiques** : `/var/lib/aslf/backups/AAAA-MM-JJ/` (articles, membres, messages),
  30 derniers jours. Les photos (`/var/lib/aslf/uploads/`) ne sont jamais modifiées
  après envoi.
- **Complètes, à garder ailleurs** : dans l’espace de gestion, *Réglages › Télécharger une
  sauvegarde complète* (fichier ZIP avec les photos). À faire une fois par mois.
- **Conseillé** : activer les instantanés (« snapshots ») automatiques chez l’hébergeur du VPS.

### Restaurer une sauvegarde

```bash
sudo systemctl stop aslf
# ZIP téléchargé depuis l'espace de gestion :
sudo unzip -o sauvegarde-aslf-AAAA-MM-JJ.zip -d /var/lib/aslf
# ou copie automatique d'un jour précis :
sudo cp /var/lib/aslf/backups/AAAA-MM-JJ/*.json /var/lib/aslf/
sudo chown -R aslf:aslf /var/lib/aslf
sudo systemctl start aslf
```

## 6. Sécurité, en résumé

- Le site n’écoute qu’en local (`127.0.0.1:3456`) ; seul Caddy est exposé (ports 80/443).
- Le pare-feu n’ouvre que SSH, HTTP et HTTPS.
- Le service tourne sous un utilisateur dédié sans droits, ne peut écrire que dans
  `/var/lib/aslf`, mémoire limitée à 512 Mo.
- Mot de passe stocké uniquement sous forme d’empreinte scrypt ; sessions en cookie
  HttpOnly/Secure ; 10 essais de connexion par quart d’heure et par adresse.
- Contenu des articles filtré par liste blanche à chaque enregistrement ; politique de
  sécurité du contenu (CSP) sur toutes les pages.
- Formulaire de contact : 5 messages par heure et par adresse, piège à robots.

## 7. Configuration

`/etc/aslf/aslf.env` (voir `deploy/aslf.env.exemple`) :

| Variable | Rôle | Valeur par défaut |
|---|---|---|
| `SITE_URL` | adresse publique (liens de partage, sitemap) | — |
| `PORT`, `HOST` | où écoute le site | `3456`, `127.0.0.1` |
| `TRUST_PROXY` | faire confiance à Caddy pour l’adresse IP du visiteur | `1` |
| `DATA_DIR` | dossier des données | `/var/lib/aslf` |
| `BACKUP_DAYS` | jours de sauvegardes conservés | `30` |
| `TRASH_DAYS` | jours avant de vider la corbeille | `30` |
