"""
ASLF — Envoie les photos et vidéos des événements (dossier local medias/) sur Hostinger,
dans le dossier « medias » situé à côté de public_html (jamais effacé par un déploiement).

Identifiants d'envoi : outil Hostinger « hosting_files_generate-upload-url » (valables quelques heures),
passés en variables d'environnement :
    $env:HOSTINGER_TUS_URL = "https://srvXXXX-files.hstgr.io/rest/…/api/tus/public_html"
    $env:HOSTINGER_X_AUTH = "…"; $env:HOSTINGER_X_AUTH_REST = "…"
    python scripts/envoyer-medias.py            (tout envoyer)
    python scripts/envoyer-medias.py 05-celebr  (seulement les fichiers dont le chemin contient ce texte)
"""
import concurrent.futures
import os
import pathlib
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCAL = ROOT / "medias"


def send(url_base: str, headers: dict, path: pathlib.Path) -> str:
    rel = path.relative_to(LOCAL).as_posix()
    target = f"{url_base}/medias/{urllib.parse.quote(rel)}?override=true"
    data = path.read_bytes()
    common = {**headers, "Tus-Resumable": "1.0.0"}
    create = urllib.request.Request(target, method="POST",
                                    headers={**common, "Upload-Length": str(len(data)), "Upload-Offset": "0"})
    with urllib.request.urlopen(create, timeout=60) as r:
        if r.status != 201:
            raise RuntimeError(f"{rel} : création refusée ({r.status})")
    patch = urllib.request.Request(target, method="PATCH", data=data,
                                   headers={**common, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"})
    with urllib.request.urlopen(patch, timeout=600) as r:
        if int(r.headers.get("Upload-Offset", -1)) != len(data):
            raise RuntimeError(f"{rel} : envoi incomplet")
    return rel


def main() -> None:
    tus = os.environ.get("HOSTINGER_TUS_URL", "")
    if not tus.endswith("/public_html"):
        sys.exit("HOSTINGER_TUS_URL doit être l'adresse renvoyée par Hostinger (se terminant par /public_html)")
    base = tus[: -len("/public_html")]
    headers = {"X-Auth": os.environ["HOSTINGER_X_AUTH"], "X-Auth-Rest": os.environ["HOSTINGER_X_AUTH_REST"]}
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    files = [p for p in sorted(LOCAL.rglob("*")) if p.is_file() and only in p.as_posix()]
    total = sum(p.stat().st_size for p in files)
    print(f"{len(files)} fichiers, {total / 1048576:.0f} Mo à envoyer")
    errors = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for n, fut in enumerate(concurrent.futures.as_completed([pool.submit(send, base, headers, p) for p in files]), 1):
            try:
                fut.result()
            except Exception as exc:  # noqa: BLE001 — on continue et on résume à la fin
                errors += 1
                print("ERREUR", exc)
            if n % 25 == 0 or n == len(files):
                print(f"  {n}/{len(files)}")
    print("Terminé" + (f" avec {errors} erreur(s)" if errors else " sans erreur"))
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
