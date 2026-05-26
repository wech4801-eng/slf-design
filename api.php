<?php
/**
 * SLF — API REST pour Hostinger (shared hosting PHP).
 *
 * Endpoints :
 *   POST /api/login                       { password }
 *   GET    /api/articles                  → liste publique
 *   GET    /api/articles/{id}             → un article
 *   PUT    /api/articles                  → upsert (admin)
 *   DELETE /api/articles/{id}             → suppression (admin)
 *   POST   /api/articles/{id}/view        → +1 vue (public)
 *   GET    /api/members                   → admin
 *   PUT    /api/members                   → admin
 *   DELETE /api/members/{id}              → admin
 *   GET    /api/stream                    → SSE (mises à jour temps réel)
 *   GET    /api/changes?since=TIMESTAMP   → fallback polling
 *
 * Authentification :
 *   POST /api/login renvoie { token }, à passer dans
 *   l'en-tête Authorization: Bearer <token> pour les écritures.
 *
 * Stockage : data/articles.json, data/members.json, data/tokens.json
 *
 * Sécurité :
 *   - Modifier ADMIN_PASS via la variable d'environnement Hostinger
 *     (hPanel → Avancé → Variables PHP)
 *   - Ou éditer directement la constante ci-dessous.
 */

// ── Configuration ─────────────────────────────────────────────────────────
define('ADMIN_PASS', getenv('ADMIN_PASS') ?: 'WqTC^+3wjc*v3#Qnbp');
define('DATA_DIR',   __DIR__ . '/data');
define('TOKEN_TTL',  7 * 24 * 3600); // 7 jours
define('MAX_BODY',   12 * 1024 * 1024); // 12 Mo (images base64)

// ── Création du dossier de données ────────────────────────────────────────
if (!is_dir(DATA_DIR)) {
    @mkdir(DATA_DIR, 0755, true);
}
foreach (['articles', 'members', 'tokens'] as $f) {
    $p = DATA_DIR . '/' . $f . '.json';
    if (!file_exists($p)) {
        file_put_contents($p, $f === 'tokens' ? '{}' : '[]', LOCK_EX);
    }
}
// Touch un fichier "last-change" pour le polling
$LAST_CHANGE_FILE = DATA_DIR . '/last-change.txt';
if (!file_exists($LAST_CHANGE_FILE)) {
    file_put_contents($LAST_CHANGE_FILE, time(), LOCK_EX);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function json_response($code, $data) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function read_collection($name) {
    $p = DATA_DIR . '/' . $name . '.json';
    if (!file_exists($p)) return [];
    $raw = file_get_contents($p);
    $arr = json_decode($raw, true);
    return is_array($arr) ? $arr : [];
}

function write_collection($name, $arr) {
    $p = DATA_DIR . '/' . $name . '.json';
    file_put_contents(
        $p,
        json_encode($arr, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        LOCK_EX
    );
    @touch($GLOBALS['LAST_CHANGE_FILE'] ?? DATA_DIR . '/last-change.txt');
}

function read_tokens() {
    $p = DATA_DIR . '/tokens.json';
    if (!file_exists($p)) return [];
    $t = json_decode(file_get_contents($p), true);
    return is_array($t) ? $t : [];
}
function write_tokens($t) {
    file_put_contents(DATA_DIR . '/tokens.json', json_encode($t), LOCK_EX);
}

function issue_token() {
    $token = bin2hex(random_bytes(32));
    $t = read_tokens();
    // Nettoyage des tokens expirés
    $now = time();
    foreach ($t as $k => $exp) {
        if ($exp < $now) unset($t[$k]);
    }
    $t[$token] = $now + TOKEN_TTL;
    write_tokens($t);
    return $token;
}

function check_token() {
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    $auth = $headers['Authorization'] ?? $headers['authorization'] ?? '';
    if (!preg_match('/^Bearer\s+([a-f0-9]+)$/i', $auth, $m)) return false;
    $token = $m[1];
    $t = read_tokens();
    if (!isset($t[$token])) return false;
    if ($t[$token] < time()) {
        unset($t[$token]);
        write_tokens($t);
        return false;
    }
    return true;
}

function require_auth() {
    if (!check_token()) json_response(401, ['error' => 'unauthorized']);
}

function read_body() {
    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY);
    if ($raw === false || $raw === '') return [];
    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) json_response(400, ['error' => 'invalid_json']);
    return $data;
}

// ── CORS (utile si front et back sont sur des domaines différents) ────────
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Routage ────────────────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'];
$uri    = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
// Retirer le préfixe /api/
$path = preg_replace('#^.*/api/?#', '', $uri);

// ── POST /api/login ────────
if ($path === 'login' && $method === 'POST') {
    $body = read_body();
    $pass = $body['password'] ?? '';
    if (!hash_equals(ADMIN_PASS, $pass)) {
        json_response(401, ['error' => 'invalid_password']);
    }
    json_response(200, ['token' => issue_token(), 'expiresIn' => TOKEN_TTL * 1000]);
}

// ── GET /api/stream (SSE — peut être bloqué sur certains hébergements) ───
if ($path === 'stream' && $method === 'GET') {
    @set_time_limit(0);
    @ini_set('output_buffering', 'off');
    @ini_set('zlib.output_compression', 0);
    while (ob_get_level() > 0) ob_end_flush();
    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache, no-transform');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no');
    echo ":ok\n\n"; @flush();

    $last = file_exists($LAST_CHANGE_FILE) ? filemtime($LAST_CHANGE_FILE) : 0;
    $start = time();
    while (true) {
        // 5 min max de connexion (limite shared hosting), client reconnecte
        if (time() - $start > 300) break;
        clearstatcache(true, $LAST_CHANGE_FILE);
        $cur = file_exists($LAST_CHANGE_FILE) ? filemtime($LAST_CHANGE_FILE) : 0;
        if ($cur > $last) {
            $last = $cur;
            echo "event: articles-updated\ndata: {}\n\n";
            echo "event: members-updated\ndata: {}\n\n";
            @flush();
        }
        // ping de garde
        echo ":ping\n\n"; @flush();
        if (connection_aborted()) break;
        sleep(2);
    }
    exit;
}

// ── GET /api/changes?since=TIMESTAMP (polling fallback) ─────────────────
if ($path === 'changes' && $method === 'GET') {
    $since = (int)($_GET['since'] ?? 0);
    clearstatcache(true, $LAST_CHANGE_FILE);
    $last = file_exists($LAST_CHANGE_FILE) ? filemtime($LAST_CHANGE_FILE) : 0;
    json_response(200, [
        'lastChange' => $last,
        'changed'    => $last > $since,
    ]);
}

// ── /api/articles[/{id}[/view]] ────────
if (preg_match('#^articles(?:/([^/]+))?(?:/(view))?$#', $path, $m)) {
    $id   = $m[1] ?? null;
    $verb = $m[2] ?? null;

    // POST /api/articles/{id}/view  → +1 vue (public)
    if ($id && $verb === 'view' && $method === 'POST') {
        $arts = read_collection('articles');
        $found = false;
        foreach ($arts as &$a) {
            if (($a['id'] ?? null) === $id) {
                $a['views'] = (int)($a['views'] ?? 0) + 1;
                $found = true;
                break;
            }
        }
        if (!$found) json_response(404, ['error' => 'not_found']);
        write_collection('articles', $arts);
        json_response(200, ['views' => $a['views']]);
    }

    if ($method === 'GET') {
        $arts = read_collection('articles');
        if ($id) {
            foreach ($arts as $a) {
                if (($a['id'] ?? null) === $id) json_response(200, $a);
            }
            json_response(404, ['error' => 'not_found']);
        }
        // Tri par updatedAt desc
        usort($arts, function($a, $b) {
            return strcmp($b['updatedAt'] ?? '', $a['updatedAt'] ?? '');
        });
        json_response(200, $arts);
    }

    require_auth();

    if ($method === 'PUT' || $method === 'POST') {
        $body = read_body();
        if (empty($body['id'])) json_response(400, ['error' => 'id_required']);
        $arts = read_collection('articles');
        $idx  = -1;
        foreach ($arts as $i => $a) {
            if (($a['id'] ?? null) === $body['id']) { $idx = $i; break; }
        }
        if ($idx === -1) array_unshift($arts, $body);
        else             $arts[$idx] = $body;
        write_collection('articles', $arts);
        json_response(200, $body);
    }

    if ($method === 'DELETE' && $id) {
        $arts = read_collection('articles');
        $next = array_values(array_filter($arts, fn($a) => ($a['id'] ?? null) !== $id));
        if (count($next) === count($arts)) json_response(404, ['error' => 'not_found']);
        write_collection('articles', $next);
        http_response_code(204);
        exit;
    }
}

// ── /api/members[/{id}] ────────
if (preg_match('#^members(?:/([^/]+))?$#', $path, $m)) {
    require_auth();
    $id = $m[1] ?? null;

    if ($method === 'GET') {
        json_response(200, read_collection('members'));
    }
    if ($method === 'PUT' || $method === 'POST') {
        $body = read_body();
        if (empty($body['id'])) json_response(400, ['error' => 'id_required']);
        $mems = read_collection('members');
        $idx  = -1;
        foreach ($mems as $i => $mm) {
            if (($mm['id'] ?? null) === $body['id']) { $idx = $i; break; }
        }
        if ($idx === -1) array_unshift($mems, $body);
        else             $mems[$idx] = $body;
        write_collection('members', $mems);
        json_response(200, $body);
    }
    if ($method === 'DELETE' && $id) {
        $mems = read_collection('members');
        $next = array_values(array_filter($mems, fn($mm) => ($mm['id'] ?? null) !== $id));
        write_collection('members', $next);
        http_response_code(204);
        exit;
    }
}

json_response(404, ['error' => 'api_route_not_found', 'path' => $path]);
