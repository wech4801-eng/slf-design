"""
ASLF — Prépare l'archive à déployer sur Hostinger : dist/aslf-site.zip

Usage :
    python scripts/paquet-hostinger.py            (archive de production)
    python scripts/paquet-hostinger.py --debug    (affiche le détail des erreurs : mise au point uniquement)

Le mot de passe initial de l'administration est lu dans data/ACCES-ADMIN.txt
(ligne « Mot de passe : … », fichier jamais commité). Seule son empreinte
SHA-256 part dans l'archive (public/app/mot-de-passe-initial.php) ; elle ne sert
qu'à la toute première connexion, avant d'être remplacée par une empreinte forte.
"""
import hashlib
import pathlib
import re
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
DIST = ROOT / "dist"
ACCESS = ROOT / "data" / "ACCES-ADMIN.txt"
INITIAL = PUBLIC / "app" / "mot-de-passe-initial.php"
DEBUG_FLAG = PUBLIC / "app" / ".debug"


def initial_password_file() -> None:
    if not ACCESS.exists():
        sys.exit(f"Fichier introuvable : {ACCESS} (ligne attendue : « Mot de passe : … »)")
    match = re.search(r"^Mot de passe\s*:\s*(\S.*)$", ACCESS.read_text(encoding="utf-8"), re.M)
    if not match:
        sys.exit("Ligne « Mot de passe : … » absente de data/ACCES-ADMIN.txt")
    digest = hashlib.sha256(match.group(1).strip().encode("utf-8")).hexdigest()
    INITIAL.write_text(
        "<?php\n// Empreinte du mot de passe initial (première connexion uniquement). Généré par scripts/paquet-hostinger.py\n"
        f"return ['sha256' => '{digest}'];\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> None:
    debug = "--debug" in sys.argv
    initial_password_file()
    if debug:
        DEBUG_FLAG.write_text("mise au point\n", encoding="utf-8")
    elif DEBUG_FLAG.exists():
        DEBUG_FLAG.unlink()

    DIST.mkdir(exist_ok=True)
    target = DIST / "aslf-site.zip"
    count = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(PUBLIC.rglob("*")):
            if path.is_dir() or path.name in {"Thumbs.db", "desktop.ini", ".DS_Store"}:
                continue
            zf.write(path, path.relative_to(PUBLIC).as_posix())
            count += 1
    size = target.stat().st_size / 1048576
    print(f"{target.relative_to(ROOT)} : {count} fichiers, {size:.1f} Mo" + (" (mode mise au point)" if debug else ""))


if __name__ == "__main__":
    main()
