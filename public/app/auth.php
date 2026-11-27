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

// ── Comptes d'administration : plusieurs personnes, chacune avec son identifiant ──
const DEFAULT_LOGIN = 'admin';

function admins_table(): void
{
    static $done = false;
    if ($done) return;
    $pdo = db();
    $pdo->exec('CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, created_at TEXT NOT NULL, last_login TEXT)');
    $cols = array_column($pdo->query('PRAGMA table_info(sessions)')->fetchAll(), 'name');
    if (!in_array('admin_id', $cols, true)) $pdo->exec('ALTER TABLE sessions ADD COLUMN admin_id INTEGER');
    // Reprise de l'ancien compte unique (identifiant + empreinte rangés dans les réglages)
    $oldHash = setting_get('password_hash');
    if ($oldHash) {
        if ((int) $pdo->query('SELECT COUNT(*) FROM admins')->fetchColumn() === 0) {
            $pdo->prepare('INSERT INTO admins (login, hash, created_at) VALUES (?, ?, ?)')
                ->execute([setting_get('admin_login', DEFAULT_LOGIN) ?? DEFAULT_LOGIN, $oldHash, now_iso()]);
        }
        $pdo->prepare('DELETE FROM settings WHERE name IN (?, ?)')->execute(['password_hash', 'admin_login']);
    }
    // Mot de passe oublié : un fichier « REINITIALISER-MOT-DE-PASSE » déposé dans aslf-data
    // (hPanel → Gestionnaire de fichiers) efface les comptes ; l'identifiant « admin » et le
    // mot de passe initial livré avec le site redeviennent valables.
    $reset = DATA_DIR . '/REINITIALISER-MOT-DE-PASSE';
    if (is_file($reset)) {
        $pdo->exec('DELETE FROM admins');
        $pdo->exec('DELETE FROM sessions');
        @unlink($reset);
    }
    $done = true;
}

function count_admins(): int
{
    admins_table();
    return (int) db()->query('SELECT COUNT(*) FROM admins')->fetchColumn();
}

function find_admin(string $login): ?array
{
    admins_table();
    $st = db()->prepare('SELECT id, login, hash, created_at, last_login FROM admins WHERE login = ?');
    $st->execute([mb_strtolower(trim($login))]);
    return $st->fetch() ?: null;
}

function admin_by_id(int $id): ?array
{
    admins_table();
    $st = db()->prepare('SELECT id, login, hash, created_at, last_login FROM admins WHERE id = ?');
    $st->execute([$id]);
    return $st->fetch() ?: null;
}

function initial_password_ok(string $pw): bool
{
    $file = __DIR__ . '/mot-de-passe-initial.php';
    $initial = is_file($file) ? (require $file) : null;
    return is_array($initial) && !empty($initial['sha256']) && hash_equals((string) $initial['sha256'], hash('sha256', $pw));
}

/** Identifiant ET mot de passe. Renvoie le compte, ou null (sans dire lequel des deux est faux). */
function verify_admin_credentials(string $login, string $pw): ?array
{
    admins_table();
    $login = mb_strtolower(trim($login));
    $admin = $login !== '' ? find_admin($login) : null;
    if ($admin) return password_verify($pw, $admin['hash']) ? $admin : null;
    // Aucun compte encore : identifiant « admin » + mot de passe initial livré avec le site
    if (count_admins() === 0 && $login === DEFAULT_LOGIN && initial_password_ok($pw)) {
        db()->prepare('INSERT INTO admins (login, hash, created_at) VALUES (?, ?, ?)')->execute([DEFAULT_LOGIN, password_hash($pw, PASSWORD_DEFAULT), now_iso()]);
        return find_admin(DEFAULT_LOGIN);
    }
    password_verify($pw, '$2y$10$abcdefghijklmnopqrstuuJ0GqEJSbXqkvvIqF6t9b0R2VtNUyB7e'); // même durée de réponse
    return null;
}

function clean_login(string $login): string
{
    $login = mb_strtolower(trim($login));
    if (mb_strlen($login) < 3 || mb_strlen($login) > 160) throw http_error(400, 'L’identifiant doit faire entre 3 et 160 caractères.');
    if (!preg_match('/^[\p{L}\p{N}._@+-]+$/u', $login)) {
        throw http_error(400, 'L’identifiant ne peut contenir que des lettres, des chiffres et les signes . _ - @ + (pas d’espace).');
    }
    return $login;
}

function set_admin_login(int $id, string $login): string
{
    $login = clean_login($login);
    $other = find_admin($login);
    if ($other && (int) $other['id'] !== $id) throw http_error(409, 'Cet identifiant est déjà utilisé par un autre compte.');
    db()->prepare('UPDATE admins SET login = ? WHERE id = ?')->execute([$login, $id]);
    return $login;
}

function set_admin_password(int $id, string $pw): void
{
    $problem = password_problem($pw);
    if ($problem) throw http_error(400, $problem);
    db()->prepare('UPDATE admins SET hash = ? WHERE id = ?')->execute([password_hash($pw, PASSWORD_DEFAULT), $id]);
}

function create_admin(string $login, string $pw): array
{
    $login = clean_login($login);
    if (find_admin($login)) throw http_error(409, 'Cet identifiant est déjà utilisé par un autre compte.');
    $problem = password_problem($pw);
    if ($problem) throw http_error(400, $problem);
    db()->prepare('INSERT INTO admins (login, hash, created_at) VALUES (?, ?, ?)')->execute([$login, password_hash($pw, PASSWORD_DEFAULT), now_iso()]);
    return public_admin(find_admin($login));
}

function delete_admin(int $id, int $currentId): void
{
    if ($id === $currentId) throw http_error(400, 'Vous ne pouvez pas supprimer votre propre compte.');
    if (!admin_by_id($id)) throw http_error(404, 'Compte introuvable.');
    if (count_admins() <= 1) throw http_error(400, 'Il doit rester au moins un compte.');
    db()->prepare('DELETE FROM sessions WHERE admin_id = ?')->execute([$id]);
    db()->prepare('DELETE FROM admins WHERE id = ?')->execute([$id]);
}

function public_admin(array $a): array
{
    return ['id' => (int) $a['id'], 'identifiant' => $a['login'], 'cree' => $a['created_at'], 'derniereConnexion' => $a['last_login']];
}

function list_admins(): array
{
    admins_table();
    return array_map('public_admin', db()->query('SELECT id, login, created_at, last_login FROM admins ORDER BY id')->fetchAll());
}

// ── Sessions ─────────────────────────────────────────────────────────────────
function create_session(int $adminId): string
{
    admins_table();
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $now = time();
    db()->prepare('INSERT INTO sessions (hash, created, seen, exp, admin_id) VALUES (?, ?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $now, $now, $now + SESSION_DAYS * 86400, $adminId]);
    db()->prepare('UPDATE admins SET last_login = ? WHERE id = ?')->execute([now_iso(), $adminId]);
    return $token;
}

/** Empreinte de la session si la requête est authentifiée, sinon null. */
function session_key(): ?string
{
    return session_info()['hash'] ?? null;
}

/** Session courante : empreinte et compte connecté. */
function session_info(): ?array
{
    static $info = false;
    if ($info !== false) return $info;
    $info = null;
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($token) || $token === '' || strlen($token) > 100) return null;
    admins_table();
    $hash = hash('sha256', $token);
    $st = db()->prepare('SELECT seen, exp, admin_id FROM sessions WHERE hash = ?');
    $st->execute([$hash]);
    $s = $st->fetch();
    if (!$s) return null;
    $now = time();
    if ($now > (int) $s['exp']) {
        db()->prepare('DELETE FROM sessions WHERE hash = ?')->execute([$hash]);
        return null;
    }
    // Session ouverte avant l'arrivée des comptes multiples : rattachée au premier compte
    $admin = $s['admin_id'] !== null ? admin_by_id((int) $s['admin_id']) : null;
    if (!$admin) {
        $first = db()->query('SELECT id FROM admins ORDER BY id LIMIT 1')->fetchColumn();
        if ($first === false) return null;
        $admin = admin_by_id((int) $first);
        db()->prepare('UPDATE sessions SET admin_id = ? WHERE hash = ?')->execute([(int) $first, $hash]);
    }
    // Prolongation glissante, écrite au plus une fois par heure
    if ($now - (int) $s['seen'] > 3600) {
        db()->prepare('UPDATE sessions SET seen = ?, exp = ? WHERE hash = ?')->execute([$now, $now + SESSION_DAYS * 86400, $hash]);
    }
    $info = ['hash' => $hash, 'admin' => $admin];
    return $info;
}

function current_admin(): ?array
{
    return session_info()['admin'] ?? null;
}

function destroy_session(?string $key): void
{
    if ($key) db()->prepare('DELETE FROM sessions WHERE hash = ?')->execute([$key]);
}

/** Déconnecte les autres appareils du même compte. */
function destroy_other_sessions(string $keep): void
{
    $me = current_admin();
    if (!$me) return;
    db()->prepare('DELETE FROM sessions WHERE hash <> ? AND admin_id = ?')->execute([$keep, (int) $me['id']]);
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
