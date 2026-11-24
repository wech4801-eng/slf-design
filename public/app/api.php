<?php
/**
 * ASLF — API du site (mêmes adresses que l'ancien serveur Node : le site
 * public et l'administration n'ont pas eu à changer).
 */
declare(strict_types=1);

function require_admin(): string
{
    $key = session_key();
    if (!$key) throw http_error(401, 'Votre session a expiré. Reconnectez-vous.');
    return $key;
}

/** Protection CSRF : en-tête propre au site + origine identique. */
function check_same_origin(): void
{
    if (header_value('X-Requested-With') !== 'ASLF') throw http_error(403, 'Requête refusée.');
    $origin = header_value('Origin');
    if ($origin !== '' && $origin !== 'null') {
        $host = parse_url($origin, PHP_URL_HOST);
        $port = parse_url($origin, PHP_URL_PORT);
        $originHost = $host . ($port ? ':' . $port : '');
        if (!$host || strcasecmp($originHost, (string) ($_SERVER['HTTP_HOST'] ?? '')) !== 0) {
            throw http_error(403, 'Requête refusée.');
        }
    }
}

function site_status(): array
{
    $list = admin_articles();
    $uploads = list_uploads();
    $free = @disk_free_space(DATA_DIR);
    return [
        'version' => ASLF_VERSION,
        'articles' => [
            'enLigne' => count(array_filter($list, static fn ($a) => $a['isPublic'] && !$a['deletedAt'])),
            'brouillons' => count(array_filter($list, static fn ($a) => !$a['isPublic'] && !$a['deletedAt'])),
            'corbeille' => count(array_filter($list, static fn ($a) => (bool) $a['deletedAt'])),
        ],
        'membres' => (int) db()->query('SELECT COUNT(*) FROM members')->fetchColumn(),
        'messagesNonLus' => unread_messages(),
        'photos' => ['nombre' => count($uploads), 'poids' => array_sum(array_column($uploads, 'size'))],
        'disqueLibre' => $free === false ? null : (int) $free,
        'derniereSauvegarde' => last_backup(),
        'demarrage' => null,
        'systeme' => 'PHP ' . PHP_VERSION . ' · SQLite ' . (string) db()->query('SELECT sqlite_version()')->fetchColumn(),
    ];
}

function handle_api(): never
{
    $p = request_path();
    $m = request_method();

    // ── Public ──
    if ($p === '/api/health') send_json(200, ['ok' => true, 'version' => ASLF_VERSION]);

    if ($p === '/api/articles' && $m === 'GET') {
        $section = (string) ($_GET['section'] ?? '');
        $offset = max(0, (int) ($_GET['offset'] ?? 0));
        $limit = min(100, max(1, (int) ($_GET['limit'] ?? 24)));
        $list = public_articles();
        if ($section !== '') $list = array_values(array_filter($list, static fn ($a) => $a['section'] === $section));
        send_json(200, ['total' => count($list), 'articles' => array_slice($list, $offset, $limit)], ['Cache-Control' => 'public, max-age=30']);
    }

    if (preg_match('~^/api/articles/([\w-]{1,120})$~', $p, $mm) && $m === 'GET') {
        $a = get_article($mm[1]);
        if (!$a || !is_public($a)) throw http_error(404, 'Article introuvable.');
        send_json(200, article_full($a, false), ['Cache-Control' => 'public, max-age=30']);
    }
    if (preg_match('~^/api/articles/([\w-]{1,120})/vue$~', $p, $mm) && $m === 'POST') {
        $views = count_view($mm[1]);
        send_json($views === null ? 404 : 200, ['views' => $views]);
    }

    // ── Formulaire de contact (public) ──
    if ($p === '/api/contact' && $m === 'POST') {
        check_same_origin();
        $body = read_json(32 * 1024);
        // Champ piège invisible : rempli uniquement par les robots
        if (!empty($body['site'])) send_json(200, ['ok' => true]);
        if (throttle_count('contact', 3600) >= 5) {
            throw http_error(429, 'Vous avez déjà envoyé plusieurs messages. Réessayez dans une heure, ou écrivez-nous par e-mail.');
        }
        add_message($body);
        throttle_hit('contact');
        send_json(201, ['ok' => true]);
    }

    // ── Session ──
    if ($p === '/api/session' && $m === 'GET') send_json(200, ['connected' => session_key() !== null]);

    if ($p === '/api/login' && $m === 'POST') {
        check_same_origin();
        $wait = login_blocked();
        if ($wait) throw http_error(429, "Trop d’essais. Patientez $wait minute" . ($wait > 1 ? 's' : '') . ' avant de réessayer.');
        $body = read_json(4096);
        if (!verify_admin_password((string) ($body['password'] ?? ''))) {
            throttle_hit('login');
            usleep(random_int(400000, 700000));
            throw http_error(401, 'Mot de passe incorrect. Vérifiez les majuscules et réessayez.');
        }
        throttle_clear('login');
        set_session_cookie(create_session());
        send_json(200, ['ok' => true]);
    }

    if ($p === '/api/logout' && $m === 'POST') {
        check_same_origin();
        destroy_session(session_key());
        set_session_cookie(null);
        send_json(200, ['ok' => true]);
    }

    // ── Administration ──
    if (!str_starts_with($p, '/api/admin/')) throw http_error(404, 'Adresse inconnue.');
    $session = require_admin();
    if ($m !== 'GET' && $m !== 'HEAD') check_same_origin();
    $ap = substr($p, strlen('/api/admin'));

    if ($ap === '/articles' && $m === 'GET') send_json(200, admin_articles());
    if ($ap === '/articles' && $m === 'POST') send_json(201, save_article(read_json()));
    if (preg_match('~^/articles/([\w-]{1,120})(/restaurer)?$~', $ap, $mm)) {
        $id = $mm[1];
        if (!empty($mm[2])) {
            if ($m !== 'POST') throw http_error(405, 'Méthode non autorisée.');
            set_article_deleted($id, false);
            send_json(200, ['ok' => true]);
        }
        if ($m === 'GET') {
            $a = get_article($id);
            if (!$a) throw http_error(404, 'Article introuvable.');
            send_json(200, article_full($a, true));
        }
        if ($m === 'PUT') send_json(200, save_article(read_json(), $id));
        if ($m === 'DELETE') {
            if (($_GET['definitif'] ?? '') === '1') destroy_article($id); else set_article_deleted($id, true);
            send_json(200, ['ok' => true]);
        }
    }

    if ($ap === '/photos' && $m === 'GET') send_json(200, list_uploads());
    if ($ap === '/photos' && $m === 'POST') send_json(201, save_upload(read_raw(MAX_UPLOAD + 1)));
    if ($ap === '/photos' && $m === 'DELETE') {
        delete_upload((string) ($_GET['url'] ?? ''));
        send_json(200, ['ok' => true]);
    }

    if ($ap === '/membres' && $m === 'GET') send_json(200, list_members());
    if ($ap === '/membres' && $m === 'POST') send_json(201, save_member(read_json(64 * 1024)));
    if (preg_match('~^/membres/([\w-]{1,60})$~', $ap, $mm)) {
        if ($m === 'PUT') send_json(200, save_member(read_json(64 * 1024), $mm[1]));
        if ($m === 'DELETE') { delete_member($mm[1]); send_json(200, ['ok' => true]); }
    }

    if ($ap === '/messages' && $m === 'GET') send_json(200, list_messages());
    if (preg_match('~^/messages/([\w-]{1,60})$~', $ap, $mm)) {
        if ($m === 'PUT') { set_message_read($mm[1], !empty(read_json(1024)['lu'])); send_json(200, ['ok' => true]); }
        if ($m === 'DELETE') { delete_message($mm[1]); send_json(200, ['ok' => true]); }
    }

    if ($ap === '/mot-de-passe' && $m === 'POST') {
        $body = read_json(4096);
        if (!verify_admin_password((string) ($body['current'] ?? ''))) throw http_error(400, 'Le mot de passe actuel est incorrect.');
        set_admin_password((string) ($body['next'] ?? ''));
        destroy_other_sessions($session);
        send_json(200, ['ok' => true]);
    }

    if ($ap === '/etat' && $m === 'GET') send_json(200, site_status());
    if ($ap === '/sauvegarde' && $m === 'GET') stream_backup();

    throw http_error(404, 'Adresse inconnue.');
}
