<?php
/**
 * ASLF — Démarrage commun : chemins, base de données, réponses HTTP, erreurs.
 *
 * Les données (base SQLite, photos, sauvegardes) vivent dans le dossier
 * « aslf-data », À CÔTÉ du dossier public du site (public_html) et jamais dedans :
 *   - elles ne sont pas accessibles directement depuis le web ;
 *   - un nouveau déploiement du site (qui remplace public_html) ne les efface pas.
 */
declare(strict_types=1);

const ASLF_VERSION = '3.0.0';

define('PUBLIC_DIR', dirname(__DIR__));
define('DATA_DIR', rtrim((string) (getenv('ASLF_DATA_DIR') ?: dirname(PUBLIC_DIR) . '/aslf-data'), '/'));
define('UPLOADS_DIR', DATA_DIR . '/uploads');
define('DOCS_DIR', DATA_DIR . '/fichiers');
define('BACKUPS_DIR', DATA_DIR . '/sauvegardes');
define('DB_FILE', DATA_DIR . '/aslf.sqlite');
// Photos et vidéos des événements (envoyées à part, trop lourdes pour l'archive du site)
define('MEDIA_DIR', dirname(PUBLIC_DIR) . '/medias');
// Domaine écrit dans les pages HTML ; remplacé à la volée par l'adresse réelle du site
const ORIGINAL_SITE_URL = 'https://www.asso-slf.org';
const TRASH_DAYS = 30;
const BACKUP_DAYS = 30;
// Fichier présent uniquement pendant la mise au point : affiche le détail des erreurs
define('DEBUG', is_file(__DIR__ . '/.debug'));

mb_internal_encoding('UTF-8');
date_default_timezone_set('Europe/Paris');
ini_set('display_errors', DEBUG ? '1' : '0');
error_reporting(E_ALL);

// ── Erreurs ──────────────────────────────────────────────────────────────────
final class HttpError extends RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

function http_error(int $status, string $message): HttpError
{
    return new HttpError($status, $message);
}

function log_error(string $message): void
{
    if (is_dir(DATA_DIR)) {
        @file_put_contents(DATA_DIR . '/erreurs.log', '[' . date('c') . '] ' . $message . "\n", FILE_APPEND | LOCK_EX);
    }
}

set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    if (!(error_reporting() & $no)) return false;
    throw new ErrorException($str, 0, $no, $file, $line);
});

set_exception_handler(static function (Throwable $e): void {
    $status = $e instanceof HttpError ? $e->status : 500;
    $message = $e instanceof HttpError ? $e->getMessage()
        : 'Une erreur est survenue sur le serveur. Réessayez dans un instant.';
    if ($status >= 500) {
        log_error(get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        if (DEBUG) $message .= ' [' . $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine() . ']';
    }
    if (headers_sent()) { echo "\n" . htmlspecialchars($message); return; }
    if (str_starts_with(request_path(), '/api/')) send_json($status, ['error' => $message]);
    send_text($status, $message);
});

// ── Dossier de données ───────────────────────────────────────────────────────
function ensure_data_dirs(): void
{
    static $done = false;
    if ($done) return;
    foreach ([DATA_DIR, UPLOADS_DIR, DOCS_DIR, BACKUPS_DIR] as $dir) {
        if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
            throw new RuntimeException("Impossible de créer le dossier de données $dir");
        }
    }
    // Protection supplémentaire si le dossier se retrouvait un jour sous la racine web
    $deny = DATA_DIR . '/.htaccess';
    if (!is_file($deny)) @file_put_contents($deny, "Require all denied\nDeny from all\n");
    $done = true;
}

// ── Base de données SQLite ───────────────────────────────────────────────────
function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    ensure_data_dirs();
    $pdo = new PDO('sqlite:' . DB_FILE, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 10,
    ]);
    foreach (['PRAGMA journal_mode = WAL', 'PRAGMA synchronous = NORMAL', 'PRAGMA busy_timeout = 10000', 'PRAGMA foreign_keys = ON'] as $sql) {
        $pdo->exec($sql);
    }
    @chmod(DB_FILE, 0640);
    migrate_schema($pdo);
    return $pdo;
}

function migrate_schema(PDO $pdo): void
{
    $pdo->exec('CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    $version = (int) (setting_get('schema', '0', $pdo));
    if ($version < 1) migrate_v1($pdo);
    if ($version < 2) {
        // v2 : documents joints aux articles (PDF, Word, Excel…)
        $pdo->exec('CREATE TABLE IF NOT EXISTS documents (
            url TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            ext TEXT NOT NULL,
            created_at TEXT NOT NULL
        )');
        setting_set('schema', '2', $pdo);
    }
}

function migrate_v1(PDO $pdo): void
{
    $pdo->beginTransaction();
    $statements = [
        'CREATE TABLE IF NOT EXISTS articles (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            section TEXT NOT NULL,
            publish_at TEXT,
            published_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            views INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL
        )',
        'CREATE INDEX IF NOT EXISTS articles_section ON articles(section)',
        'CREATE TABLE IF NOT EXISTS members (
            id TEXT PRIMARY KEY,
            nom TEXT NOT NULL DEFAULT \'\',
            prenom TEXT NOT NULL DEFAULT \'\',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            data TEXT NOT NULL
        )',
        'CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            lu INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL
        )',
        'CREATE TABLE IF NOT EXISTS sessions (
            hash TEXT PRIMARY KEY,
            created INTEGER NOT NULL,
            seen INTEGER NOT NULL,
            exp INTEGER NOT NULL
        )',
        'CREATE TABLE IF NOT EXISTS throttle (
            kind TEXT NOT NULL,
            ip TEXT NOT NULL,
            at INTEGER NOT NULL
        )',
        'CREATE INDEX IF NOT EXISTS throttle_lookup ON throttle(kind, ip, at)',
        'CREATE TABLE IF NOT EXISTS view_log (
            key TEXT PRIMARY KEY,
            at INTEGER NOT NULL
        )',
    ];
    foreach ($statements as $sql) $pdo->exec($sql);
    setting_set('schema', '1', $pdo);
    $pdo->commit();

    // Premier démarrage : les articles d'origine du site
    seed_articles($pdo);
}

function setting_get(string $name, ?string $default = null, ?PDO $pdo = null): ?string
{
    $st = ($pdo ?? db())->prepare('SELECT value FROM settings WHERE name = ?');
    $st->execute([$name]);
    $v = $st->fetchColumn();
    return $v === false ? $default : (string) $v;
}

function setting_set(string $name, string $value, ?PDO $pdo = null): void
{
    $pdo ??= db();
    $st = $pdo->prepare('UPDATE settings SET value = ? WHERE name = ?');
    $st->execute([$value, $name]);
    if ($st->rowCount() === 0) {
        $pdo->prepare('INSERT INTO settings (name, value) VALUES (?, ?)')->execute([$name, $value]);
    }
}

// ── Requête ──────────────────────────────────────────────────────────────────
function request_path(): string
{
    static $path = null;
    if ($path === null) {
        $raw = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
        $path = rawurldecode($raw === '' ? '/' : $raw);
    }
    return $path;
}

function request_method(): string
{
    return strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
}

function header_value(string $name): string
{
    if ($name === 'Content-Type') return (string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '');
    if ($name === 'Content-Length') return (string) ($_SERVER['CONTENT_LENGTH'] ?? $_SERVER['HTTP_CONTENT_LENGTH'] ?? '');
    return (string) ($_SERVER['HTTP_' . strtoupper(str_replace('-', '_', $name))] ?? '');
}

function is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') return true;
    if ((int) ($_SERVER['SERVER_PORT'] ?? 0) === 443) return true;
    return strtolower(trim(explode(',', header_value('X-Forwarded-Proto'))[0])) === 'https';
}

/** Adresse du site sans « / » final : https://www.asso-slf.org, ou l'adresse provisoire. */
function site_url(): string
{
    $host = preg_replace('/[^A-Za-z0-9.\-:\[\]]/', '', (string) ($_SERVER['HTTP_HOST'] ?? 'localhost'));
    return (is_https() ? 'https' : 'http') . '://' . $host;
}

function absolute_url(string $p): string
{
    if (preg_match('#^https?:#i', $p)) return $p;
    return site_url() . (str_starts_with($p, '/') ? $p : '/' . $p);
}

function client_ip(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? 'inconnu'), 0, 64);
}

function read_raw(int $max): string
{
    $len = (int) header_value('Content-Length');
    if ($len > $max) throw http_error(413, 'Fichier trop lourd.');
    $in = fopen('php://input', 'rb');
    $data = stream_get_contents($in, $max + 1);
    fclose($in);
    if ($data === false) $data = '';
    if (strlen($data) > $max) throw http_error(413, 'Fichier trop lourd.');
    return $data;
}

function read_json(int $max = 2097152): array
{
    if (!preg_match('#application/json#i', header_value('Content-Type'))) {
        throw http_error(415, 'Format de requête invalide.');
    }
    $raw = read_raw($max);
    if ($raw === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) throw http_error(400, 'Données illisibles.');
    return $data;
}

// ── Réponses ─────────────────────────────────────────────────────────────────
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
    . "img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; "
    . 'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com; '
    . "media-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";

function security_headers(): void
{
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('X-Frame-Options: SAMEORIGIN');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('Content-Security-Policy: ' . CSP);
    if (is_https()) header('Strict-Transport-Security: max-age=31536000');
}

function send_body(int $status, string $body, array $headers = []): never
{
    http_response_code($status);
    foreach ($headers as $k => $v) header("$k: $v");
    header('Content-Length: ' . strlen($body));
    if (request_method() !== 'HEAD') echo $body;
    exit;
}

function send_json(int $status, mixed $data, array $extra = []): never
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    send_body($status, (string) $json, $extra + ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store']);
}

function send_text(int $status, string $text, string $type = 'text/plain; charset=utf-8', array $extra = []): never
{
    send_body($status, $text, ['Content-Type' => $type] + $extra);
}

function redirect(string $location, int $status = 302): never
{
    http_response_code($status);
    header('Location: ' . $location);
    header('Cache-Control: no-store');
    exit;
}

// ── Petits utilitaires ───────────────────────────────────────────────────────
function now_iso(): string
{
    $t = microtime(true);
    return gmdate('Y-m-d\TH:i:s', (int) $t) . sprintf('.%03dZ', (int) (($t - floor($t)) * 1000));
}

function iso_or_null(mixed $v): ?string
{
    if (!is_string($v) || trim($v) === '') return null;
    $t = strtotime($v);
    return $t === false ? null : gmdate('Y-m-d\TH:i:s.000\Z', $t);
}

function ts(?string $iso): int
{
    if (!$iso) return 0;
    $t = strtotime($iso);
    return $t === false ? 0 : $t;
}

function new_id(string $prefix): string
{
    return $prefix . '_' . base_convert((string) (int) (microtime(true) * 1000), 10, 36) . bin2hex(random_bytes(3));
}

function str_clean(mixed $v, int $max): string
{
    if (is_array($v) || is_object($v)) return '';
    $s = mb_convert_encoding(trim((string) ($v ?? '')), 'UTF-8', 'UTF-8');
    return trim(mb_substr($s, 0, $max));
}

function esc_html(mixed $s): string
{
    return htmlspecialchars((string) ($s ?? ''), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

require __DIR__ . '/sections.php';
require __DIR__ . '/sanitize.php';
require __DIR__ . '/store.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/securite.php';
require __DIR__ . '/reglages.php';
