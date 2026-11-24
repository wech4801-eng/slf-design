<?php
/**
 * ASLF — Authentification de l'administration.
 *
 * - Mot de passe stocké uniquement sous forme d'empreinte (password_hash, bcrypt/argon2).
 * - Session = jeton aléatoire dans un cookie HttpOnly ; le serveur ne garde que
 *   son empreinte SHA-256, valable 30 jours, prolongée à l'usage.
 * - Anti-force brute : 10 essais par quart d'heure et par adresse IP.
 * - Premier démarrage : le mot de passe initial est vérifié d'après une empreinte
 *   livrée avec le site (app/mot-de-passe-initial.php, inaccessible depuis le web),
 *   puis remplacé par une empreinte password_hash dès la première connexion.
 */
declare(strict_types=1);

const SESSION_DAYS = 30;
const SESSION_COOKIE = 'aslf_session';
const LOGIN_WINDOW = 15 * 60;
const LOGIN_MAX = 10;

function password_problem(mixed $pw): ?string
{
    if (!is_string($pw) || mb_strlen($pw) < 10) return 'Le mot de passe doit faire au moins 10 caractères.';
    if (mb_strlen($pw) > 200) return 'Le mot de passe est trop long.';
    if (preg_match('/^(.)\1+$/u', $pw) || preg_match('/^(0123456789|azertyuiop|qwertyuiop|motdepasse|password)/i', $pw)) {
        return 'Ce mot de passe est trop facile à deviner.';
    }
    return null;
}

function verify_admin_password(string $pw): bool
{
    // Mot de passe oublié : un fichier « REINITIALISER-MOT-DE-PASSE » déposé dans aslf-data
    // (hPanel → Gestionnaire de fichiers) rend de nouveau valable le mot de passe initial.
    $reset = DATA_DIR . '/REINITIALISER-MOT-DE-PASSE';
    if (is_file($reset)) {
        db()->prepare('DELETE FROM settings WHERE name = ?')->execute(['password_hash']);
        @unlink($reset);
    }
    $hash = setting_get('password_hash');
    if ($hash) return password_verify($pw, $hash);
    // Aucun mot de passe enregistré : empreinte initiale livrée avec le site
    $file = __DIR__ . '/mot-de-passe-initial.php';
    $initial = is_file($file) ? (require $file) : null;
    if (!is_array($initial) || empty($initial['sha256'])) return false;
    if (!hash_equals((string) $initial['sha256'], hash('sha256', $pw))) return false;
    setting_set('password_hash', password_hash($pw, PASSWORD_DEFAULT));
    return true;
}

function set_admin_password(string $pw): void
{
    $problem = password_problem($pw);
    if ($problem) throw http_error(400, $problem);
    setting_set('password_hash', password_hash($pw, PASSWORD_DEFAULT));
    setting_set('password_updated', now_iso());
}

// ── Sessions ─────────────────────────────────────────────────────────────────
function create_session(): string
{
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $now = time();
    db()->prepare('INSERT INTO sessions (hash, created, seen, exp) VALUES (?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $now, $now, $now + SESSION_DAYS * 86400]);
    return $token;
}

/** Empreinte de la session si la requête est authentifiée, sinon null. */
function session_key(): ?string
{
    static $key = false;
    if ($key !== false) return $key;
    $key = null;
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($token) || $token === '' || strlen($token) > 100) return null;
    $hash = hash('sha256', $token);
    $st = db()->prepare('SELECT seen, exp FROM sessions WHERE hash = ?');
    $st->execute([$hash]);
    $s = $st->fetch();
    if (!$s) return null;
    $now = time();
    if ($now > (int) $s['exp']) {
        db()->prepare('DELETE FROM sessions WHERE hash = ?')->execute([$hash]);
        return null;
    }
    // Prolongation glissante, écrite au plus une fois par heure
    if ($now - (int) $s['seen'] > 3600) {
        db()->prepare('UPDATE sessions SET seen = ?, exp = ? WHERE hash = ?')->execute([$now, $now + SESSION_DAYS * 86400, $hash]);
    }
    $key = $hash;
    return $key;
}

function destroy_session(?string $key): void
{
    if ($key) db()->prepare('DELETE FROM sessions WHERE hash = ?')->execute([$key]);
}

function destroy_other_sessions(string $keep): void
{
    db()->prepare('DELETE FROM sessions WHERE hash <> ?')->execute([$keep]);
}

function set_session_cookie(?string $token): void
{
    setcookie(SESSION_COOKIE, $token ?? '', [
        'expires' => $token ? time() + SESSION_DAYS * 86400 : time() - 3600,
        'path' => '/',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

// ── Limitation des tentatives (connexion, formulaire de contact) ─────────────
function throttle_count(string $kind, int $window): int
{
    $st = db()->prepare('SELECT COUNT(*) FROM throttle WHERE kind = ? AND ip = ? AND at > ?');
    $st->execute([$kind, client_ip(), time() - $window]);
    return (int) $st->fetchColumn();
}

function throttle_oldest(string $kind, int $window): int
{
    $st = db()->prepare('SELECT MIN(at) FROM throttle WHERE kind = ? AND ip = ? AND at > ?');
    $st->execute([$kind, client_ip(), time() - $window]);
    return (int) $st->fetchColumn();
}

function throttle_hit(string $kind): void
{
    db()->prepare('INSERT INTO throttle (kind, ip, at) VALUES (?, ?, ?)')->execute([$kind, client_ip(), time()]);
}

function throttle_clear(string $kind): void
{
    db()->prepare('DELETE FROM throttle WHERE kind = ? AND ip = ?')->execute([$kind, client_ip()]);
}

/** Minutes d'attente restantes si l'adresse est bloquée, sinon 0. */
function login_blocked(): int
{
    if (throttle_count('login', LOGIN_WINDOW) < LOGIN_MAX) return 0;
    $oldest = throttle_oldest('login', LOGIN_WINDOW);
    return max(1, (int) ceil((LOGIN_WINDOW - (time() - $oldest)) / 60));
}
