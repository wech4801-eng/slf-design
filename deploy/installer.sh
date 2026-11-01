#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Installation du site ASLF sur un VPS neuf (Debian 12 / Ubuntu 22.04 ou plus)
#
#  1. Pointer le nom de domaine vers l'adresse IP du VPS (enregistrements A/AAAA)
#  2. Sur le VPS :
#       sudo git clone https://github.com/wech4801-eng/slf-design.git /opt/aslf
#       sudo bash /opt/aslf/deploy/installer.sh www.aslf-france.org
#
#  Le script installe Node.js, Caddy (HTTPS automatique), crée le service qui
#  redémarre tout seul, active le pare-feu et les mises à jour de sécurité.
#  Il peut être relancé sans risque : les données ne sont jamais écrasées.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR=/opt/aslf
DATA_DIR=/var/lib/aslf
ENV_DIR=/etc/aslf
ENV_FILE=$ENV_DIR/aslf.env
NODE_MAJOR=22

info()  { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m! %s\033[0m\n' "$*"; }
fail()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Lancez ce script avec sudo."
[ -f "$APP_DIR/server.js" ] || fail "Le code du site doit se trouver dans $APP_DIR (voir l'en-tête de ce script)."
command -v apt-get >/dev/null || fail "Ce script est prévu pour Debian ou Ubuntu."

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "Nom de domaine du site (ex. www.aslf-france.org) : " DOMAIN
fi
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail "Nom de domaine invalide : $DOMAIN"

# ── Paquets système ─────────────────────────────────────────────────────────
info "Mise à jour du système et installation des outils"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https \
  ufw unattended-upgrades git

# ── Node.js ─────────────────────────────────────────────────────────────────
current_node=$( (node -v 2>/dev/null || echo v0) | sed 's/^v//; s/\..*//')
if [ "$current_node" -lt 20 ]; then
  info "Installation de Node.js $NODE_MAJOR"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
node -v

# ── Caddy (serveur HTTPS, certificats Let's Encrypt automatiques) ───────────
if ! command -v caddy >/dev/null; then
  info "Installation de Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# ── Utilisateur et dossiers ─────────────────────────────────────────────────
info "Création de l'utilisateur système et des dossiers"
id aslf >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin aslf
install -d -o aslf -g aslf -m 0750 "$DATA_DIR"
install -d -m 0755 "$ENV_DIR"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

# Reprise des données d'une installation précédente (dossier data/ du dépôt)
if [ -d "$APP_DIR/data" ] && [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  warn "Données trouvées dans $APP_DIR/data : copie vers $DATA_DIR"
  cp -a "$APP_DIR/data/." "$DATA_DIR/"
  chown -R aslf:aslf "$DATA_DIR"
fi

# ── Configuration ───────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  info "Écriture de la configuration ($ENV_FILE)"
  sed "s#^SITE_URL=.*#SITE_URL=https://$DOMAIN#" "$APP_DIR/deploy/aslf.env.exemple" > "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  chgrp aslf "$ENV_FILE"
else
  warn "Configuration existante conservée : $ENV_FILE"
fi

# ── Mot de passe de l'administration ────────────────────────────────────────
if [ ! -f "$DATA_DIR/secrets.json" ]; then
  info "Choix du mot de passe de l'espace de gestion (au moins 10 caractères)"
  sudo -u aslf env DATA_DIR="$DATA_DIR" node "$APP_DIR/scripts/mot-de-passe.js" </dev/tty
fi

# ── Services systemd ────────────────────────────────────────────────────────
info "Installation du service (démarrage automatique + surveillance)"
install -m 0644 "$APP_DIR/deploy/aslf.service" /etc/systemd/system/aslf.service
install -m 0644 "$APP_DIR/deploy/aslf-sante.service" /etc/systemd/system/aslf-sante.service
install -m 0644 "$APP_DIR/deploy/aslf-sante.timer" /etc/systemd/system/aslf-sante.timer
systemctl daemon-reload
systemctl enable aslf.service aslf-sante.timer >/dev/null
systemctl restart aslf.service
systemctl start aslf-sante.timer

# ── Caddy : HTTPS et redirection du domaine sans « www » ────────────────────
info "Configuration de Caddy pour $DOMAIN"
BARE="${DOMAIN#www.}"
{
  echo "# Généré par deploy/installer.sh — site ASLF"
  echo "$DOMAIN {"
  echo "	reverse_proxy 127.0.0.1:3456"
  echo "	request_body {"
  echo "		max_size 12MB"
  echo "	}"
  echo "	header -Server"
  echo "	log {"
  echo "		output file /var/log/caddy/aslf.log {"
  echo "			roll_size 20MiB"
  echo "			roll_keep 5"
  echo "		}"
  echo "	}"
  echo "}"
  if [ "$BARE" != "$DOMAIN" ]; then
    echo ""
    echo "$BARE {"
    echo "	redir https://$DOMAIN{uri} permanent"
    echo "}"
  fi
} > /etc/caddy/Caddyfile
install -d -o caddy -g caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

# ── Pare-feu ────────────────────────────────────────────────────────────────
info "Pare-feu : SSH, HTTP et HTTPS uniquement"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# ── Mises à jour de sécurité automatiques ───────────────────────────────────
info "Mises à jour de sécurité automatiques"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF

# Journaux système limités à 200 Mo
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/aslf.conf
systemctl restart systemd-journald

# ── Vérification ────────────────────────────────────────────────────────────
info "Vérification"
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 http://127.0.0.1:3456/api/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:3456/api/health && echo
systemctl --no-pager --lines=0 status aslf.service | head -3

cat <<FIN

  ✅ Installation terminée.

  Site public          : https://$DOMAIN
  Espace de gestion    : https://$DOMAIN/admin/
  Données              : $DATA_DIR (sauvegarde automatique quotidienne dans $DATA_DIR/backups)

  Le certificat HTTPS est obtenu automatiquement dès que le domaine pointe vers ce serveur.
  Mettre à jour le site plus tard : sudo bash $APP_DIR/deploy/mettre-a-jour.sh

FIN
