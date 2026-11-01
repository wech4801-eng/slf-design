#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Mise à jour du site ASLF :  sudo bash /opt/aslf/deploy/mettre-a-jour.sh
#  Récupère la dernière version, redémarre, vérifie que le site répond.
#  En cas de problème, revient automatiquement à la version précédente.
#  Les données (/var/lib/aslf) ne sont jamais touchées.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
APP_DIR=/opt/aslf

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script avec sudo." >&2; exit 1; }
cd "$APP_DIR"

check() {
  for _ in $(seq 1 20); do
    curl -fsS --max-time 3 http://127.0.0.1:3456/api/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

install_units() {
  install -m 0644 deploy/aslf.service deploy/aslf-sante.service deploy/aslf-sante.timer /etc/systemd/system/
  systemctl daemon-reload
}

before=$(git rev-parse HEAD)
echo "Version actuelle : $(git log -1 --format='%h — %s')"
git pull --ff-only --quiet
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "Le site est déjà à jour."
  exit 0
fi
echo "Nouvelle version : $(git log -1 --format='%h — %s')"

install_units
systemctl restart aslf.service

if check; then
  echo "✅ Mise à jour réussie : le site répond."
else
  echo "✗ Le site ne répond pas après la mise à jour : retour à la version précédente." >&2
  journalctl -u aslf --no-pager -n 30 >&2 || true
  git checkout --quiet "$before" -- .
  git reset --quiet "$before"
  install_units
  systemctl restart aslf.service
  check && echo "Version précédente rétablie, le site fonctionne." >&2
  exit 1
fi
