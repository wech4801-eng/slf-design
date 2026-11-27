<?php
/**
 * ASLF — Pare-feu applicatif (« mini fail2ban »).
 *
 * Bloque TEMPORAIREMENT une adresse IP qui s'acharne, jamais définitivement :
 *   - force brute sur la connexion : 5 essais ratés en 15 min  → bloquée 1 h
 *   - robots scanneurs (wp-login.php, .env, phpmyadmin…) : 3 en 10 min → bloquée 1 h
 *   - bombardement de requêtes : plus de 180 requêtes PHP en 1 min → bloquée 30 min
 * Un administrateur connecté n'est jamais bloqué (il peut débloquer depuis Réglages).
 * Secours : déposer un fichier vide « DEBLOQUER-TOUT » dans aslf-data lève tous les blocages.
 *
 * Note : contre une attaque massive venant de milliers d'adresses, c'est l'infrastructure
 * d'Hostinger (CDN, protection réseau) qui protège ; ce pare-feu arrête les robots isolés.
 */
declare(strict_types=1);

const BAN_LOGIN_FAILS = 5;
const BAN_LOGIN_WINDOW = 15 * 60;
const BAN_LOGIN_SECONDS = 3600;
const BAN_PROBE_HITS = 3;
const BAN_PROBE_WINDOW = 10 * 60;
const BAN_PROBE_SECONDS = 3600;
const FLOOD_PER_MINUTE = 180;
const BAN_FLOOD_SECONDS = 30 * 60;
const PROBE_RE = '~(^|/)(wp-(login|admin|content|includes|config|json)|wordpress|xmlrpc\.php|phpmyadmin|pma|myadmin|adminer|'
    . 'cgi-bin|vendor/phpunit|eval-stdin|boaform|actuator|server-status|setup\.php|install\.php|shell\.php|'
    . 'config\.(php|json|ya?ml|bak|old)|\.env|\.git|\.svn|\.aws|\.ssh|\.ht(access|passwd)|backup\.(zip|sql|tar)|dump\.sql|'
    . 'administrator/|user/login|owa/|autodiscover)~i';

const BAN_REASONS = [
    'connexion' => 'Trop d’essais de connexion ratés',
    'scanner' => 'Robot qui cherche des failles',
    'saturation' => 'Trop de requêtes en une minute',
];

function firewall_tables(): void
{
    static $done = false;
    if ($done) return;
    $pdo = db();
    $pdo->exec('CREATE TABLE IF NOT EXISTS bans (ip TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1)');
    $pdo->exec('CREATE TABLE IF NOT EXISTS hits (ip TEXT NOT NULL, win INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, win))');
    $done = true;
}

/** Bloque l'adresse pour une durée limitée (jamais plus d'une heure). */
function ban_ip(string $ip, string $reason, int $seconds): int
{
    firewall_tables();
    $seconds = min($seconds, 3600);
    $until = time() + $seconds;
    $st = db()->prepare('UPDATE bans SET until = ?, reason = ?, count = count + 1 WHERE ip = ?');
    $st->execute([$until, $reason, $ip]);
    if ($st->rowCount() === 0) {
        db()->prepare('INSERT INTO bans (ip, until, reason, created) VALUES (?, ?, ?, ?)')->execute([$ip, $until, $reason, time()]);
    }
    log_error("pare-feu : $ip bloquée " . round($seconds / 60) . " min ($reason)");
    return $until;
}

function respond_banned(int $until): never
{
    $minutes = max(1, (int) ceil(($until - time()) / 60));
    header('Retry-After: ' . max(1, $until - time()));
    $msg = "Accès temporairement bloqué : trop de tentatives depuis votre connexion. Réessayez dans $minutes minute" . ($minutes > 1 ? 's' : '') . '.';
    if (str_starts_with(request_path(), '/api/')) send_json(429, ['error' => $msg]);
    send_body(429, '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<meta name="robots" content="noindex"><title>Accès temporairement bloqué · ASLF</title>'
        . '<body style="font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#212529">'
        . '<div style="height:6px;background:linear-gradient(#006D21 0 33%,#fff 33% 66%,#D21034 66%);border-radius:3px;margin-bottom:24px"></div>'
        . '<h1 style="font-size:24px">Accès temporairement bloqué</h1><p>' . esc_html($msg) . '</p>'
        . '<p style="color:#6c757d;font-size:14px">Si vous pensez que c’est une erreur, patientez simplement : le blocage se lève tout seul.</p></body></html>',
        ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store']);
}

/** Point de contrôle au début de chaque requête PHP. */
function firewall(): void
{
    firewall_tables();
    $reset = DATA_DIR . '/DEBLOQUER-TOUT';
    if (is_file($reset)) {
        db()->exec('DELETE FROM bans');
        db()->exec('DELETE FROM throttle');
        @unlink($reset);
    }
    // Un administrateur connecté n'est jamais bloqué
    if (session_key() !== null) return;

    $ip = client_ip();
    $now = time();
    $st = db()->prepare('SELECT until FROM bans WHERE ip = ? AND until > ?');
    $st->execute([$ip, $now]);
    $until = $st->fetchColumn();
    if ($until !== false) respond_banned((int) $until);

    $path = request_path();
    // Robots qui cherchent des failles connues (ce site n'a ni WordPress, ni phpMyAdmin…)
    if (preg_match(PROBE_RE, $path)) {
        record_probe();
        not_found();
    }
    // Bombardement : les photos et vidéos (souvent lues par morceaux) ne sont pas comptées
    if (!preg_match('~^/(medias|uploads|fichiers)/~', $path)) {
        $win = intdiv($now, 60);
        $st = db()->prepare('INSERT INTO hits (ip, win, n) VALUES (?, ?, 1) ON CONFLICT(ip, win) DO UPDATE SET n = n + 1 RETURNING n');
        $st->execute([$ip, $win]);
        $n = (int) $st->fetchColumn();
        $st->closeCursor();
        if ($n > FLOOD_PER_MINUTE) respond_banned(ban_ip($ip, 'saturation', BAN_FLOOD_SECONDS));
        if (random_int(1, 200) === 1) db()->prepare('DELETE FROM hits WHERE win < ?')->execute([$win - 5]);
    }
}

/** Requête typique d'un robot (chemin piégé, champ piège du formulaire rempli). */
function record_probe(): void
{
    throttle_hit('scanner');
    if (throttle_count('scanner', BAN_PROBE_WINDOW) >= BAN_PROBE_HITS) ban_ip(client_ip(), 'scanner', BAN_PROBE_SECONDS);
}

/** Échec de connexion : au 5e en 15 minutes, l'adresse est bloquée une heure. */
function record_login_failure(): void
{
    throttle_hit('login');
    if (throttle_count('login', BAN_LOGIN_WINDOW) >= BAN_LOGIN_FAILS) {
        $until = ban_ip(client_ip(), 'connexion', BAN_LOGIN_SECONDS);
        throttle_clear('login');
        respond_banned($until);
    }
}

function list_bans(): array
{
    firewall_tables();
    $st = db()->prepare('SELECT ip, until, reason, count FROM bans WHERE until > ? ORDER BY until DESC');
    $st->execute([time()]);
    return array_map(static fn ($b) => [
        'ip' => $b['ip'],
        'jusqua' => gmdate('Y-m-d\TH:i:s\Z', (int) $b['until']),
        'raison' => BAN_REASONS[$b['reason']] ?? $b['reason'],
        'fois' => (int) $b['count'],
    ], $st->fetchAll());
}

function unban_ip(string $ip): void
{
    firewall_tables();
    db()->prepare('DELETE FROM bans WHERE ip = ?')->execute([$ip]);
    db()->prepare('DELETE FROM throttle WHERE ip = ?')->execute([$ip]);
    db()->prepare('DELETE FROM hits WHERE ip = ?')->execute([$ip]);
}

function purge_firewall(): void
{
    firewall_tables();
    db()->prepare('DELETE FROM bans WHERE until < ?')->execute([time() - 86400]);
    db()->prepare('DELETE FROM hits WHERE win < ?')->execute([intdiv(time(), 60) - 5]);
}
