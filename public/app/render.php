<?php
/**
 * ASLF — Pages du site : articles injectés directement dans le HTML
 * (affichage immédiat, bon référencement), photos, sitemap, robots.
 */
declare(strict_types=1);

const LEGACY = [
    '/admin-login.html' => '/admin/connexion.html',
    '/admin-dashboard.html' => '/admin/',
    '/admin-editor.html' => '/admin/article.html',
    '/admin-membres.html' => '/admin/membres.html',
    '/admin-medias.html' => '/admin/photos.html',
    '/admin-categories.html' => '/admin/',
    '/admin-parametres.html' => '/admin/reglages.html',
    // Pages regroupées le 28/11/2026 (menu à 7 entrées)
    '/qui-sommes-nous.html' => '/association.html#qui-sommes-nous',
    '/qui-sommes-nous' => '/association.html#qui-sommes-nous',
    '/notre-but.html' => '/association.html#nos-missions',
    '/notre-but' => '/association.html#nos-missions',
    '/appel-cotisation.html' => '/bulletin-adhesion.html',
    '/appel-cotisation' => '/bulletin-adhesion.html',
    '/radios.html' => '/medias.html',
    '/radios' => '/medias.html',
];
const MIME = ['webp' => 'image/webp', 'jpg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif'];

/** JSON sûr dans une balise <script> (« < », « > », « & » échappés). */
function json_for_html(mixed $v): string
{
    return (string) json_encode($v, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

function section_pages(): array
{
    $map = [];
    foreach (SECTIONS as $s) $map[basename($s['page'], '.html')] = $s['key'];
    return $map;
}

/** Données injectées selon la page : liste d'articles ou article complet. */
function page_data(string $page, bool $admin): ?array
{
    $pub = public_articles();
    if ($page === 'index') return ['data' => ['articles' => array_slice($pub, 0, 6), 'total' => count($pub)]];
    if ($page === 'news') return ['data' => ['articles' => array_slice($pub, 0, 24), 'total' => count($pub)]];
    if ($page === 'article') {
        $id = substr((string) ($_GET['id'] ?? ''), 0, 120);
        $a = $id !== '' && preg_match('/^[\w-]+$/', $id) ? get_article($id) : null;
        if (!$a || (!is_public($a) && !$admin)) {
            return ['data' => ['article' => null], 'status' => $id !== '' ? 404 : 200];
        }
        $related = array_values(array_filter($pub, static fn ($x) => $x['id'] !== $a['id']
            && ($x['section'] === $a['section'] || (($a['categoryKey'] ?? '') !== '' && $x['categoryKey'] === $a['categoryKey']))));
        return [
            'data' => ['article' => article_full($a, false), 'related' => array_slice($related, 0, 3), 'draft' => !is_public($a), 'admin' => $admin],
            'article' => $a,
        ];
    }
    $section = section_pages()[$page] ?? null;
    if ($section) {
        return ['data' => ['section' => $section, 'articles' => array_values(array_filter($pub, static fn ($x) => $x['section'] === $section))]];
    }
    return null;
}

function set_meta(string $html, string $attr, string $name, string $value): string
{
    $re = '~(<meta\s+' . $attr . '="' . preg_quote($name, '~') . '"\s+content=")[^"]*"~i';
    return preg_replace_callback($re, static fn ($m) => $m[1] . esc_html($value) . '"', $html, 1) ?? $html;
}

function render_page(string $src, string $page, bool $admin): array
{
    $html = $src;
    $base = site_url();
    if ($base !== ORIGINAL_SITE_URL) $html = str_replace(ORIGINAL_SITE_URL, $base, $html);
    $pd = page_data($page, $admin);
    if ($pd && !empty($pd['article'])) {
        $a = $pd['article'];
        $s = article_summary($a, false);
        $title = (($a['seoTitle'] ?? '') ?: $a['title']) . ' · ASLF';
        $desc = mb_substr((($a['metaDesc'] ?? '') ?: $s['chapeau']), 0, 200);
        $img = absolute_url($s['coverImage'] ?: '/images/partage-aslf.jpg');
        $link = absolute_url('/article.html?id=' . rawurlencode($a['slug'] ?? $a['id']));
        $html = preg_replace('~<title>[\s\S]*?</title>~', '<title>' . esc_html($title) . '</title>', $html, 1) ?? $html;
        $html = set_meta($html, 'name', 'description', $desc);
        foreach (['og:title' => $title, 'og:description' => $desc, 'og:image' => $img, 'og:url' => $link, 'og:type' => 'article'] as $k => $v) {
            $html = set_meta($html, 'property', $k, $v);
        }
        foreach (['twitter:title' => $title, 'twitter:description' => $desc, 'twitter:image' => $img] as $k => $v) {
            $html = set_meta($html, 'name', $k, $v);
        }
        $html = preg_replace_callback('~(<link\s+rel="canonical"\s+href=")[^"]*"~i', static fn ($m) => $m[1] . esc_html($link) . '"', $html, 1) ?? $html;
        if (!is_public($a)) $html = str_replace('<head>', "<head>\n  <meta name=\"robots\" content=\"noindex\" />", $html);
    }
    if ($pd) {
        $tag = '<script id="aslf-data" type="application/json">' . json_for_html($pd['data']) . '</script>';
        $pos = strripos($html, '</body>');
        $html = $pos !== false ? substr_replace($html, $tag . "\n", $pos, 0) : $html . $tag;
    }
    $html = str_replace('<!--HELLOASSO-->', adhesion_block(), $html);
    $html = str_replace('<!--RDV-->', rdv_block(), $html);
    if (str_contains($html, '<!--BULLETIN-')) {
        [$bouton, $etape] = bulletin_parts();
        $html = str_replace(['<!--BULLETIN-BOUTON-->', '<!--BULLETIN-ETAPE-->'], [$bouton, $etape], $html);
    }
    $html = str_replace('<!--MAJ-->', ' · <span class="page-maj">Page mise à jour le ' . date_fr(page_updated($page, $pd)) . '</span>', $html);
    return [$html, $pd['status'] ?? 200];
}

/**
 * Cache navigateur sans entretien : chaque « fichier?v=… » cité dans une page
 * reçoit une version calculée d'après sa date et sa taille.
 */
function version_assets(string $html, string $pageRel): string
{
    $pageDir = dirname($pageRel);
    return preg_replace_callback('~((?:href|src)=")([^"?#:]+)\?v=[^"#]*~', static function ($m) use ($pageDir) {
        $p = $m[2];
        $rel = str_starts_with($p, '/') ? $p : rtrim($pageDir, '/') . '/' . $p;
        $full = resolve_public($rel, true);
        if (!$full) return $m[0];
        return $m[1] . $p . '?v=' . base_convert((string) filesize($full), 10, 36) . base_convert((string) filemtime($full), 10, 36);
    }, $html) ?? $html;
}

/** Résout un chemin d'URL dans public/ en refusant toute sortie du dossier et les fichiers cachés. */
function resolve_public(string $urlPath, bool $anyFile = false): ?string
{
    if (str_contains($urlPath, "\0") || preg_match('~(^|/)\.~', $urlPath)) return null;
    $parts = [];
    foreach (explode('/', $urlPath) as $seg) {
        if ($seg === '' || $seg === '.') continue;
        if ($seg === '..') return null;
        $parts[] = $seg;
    }
    if (!$parts || $parts[0] === 'app') return null;
    $real = realpath(PUBLIC_DIR . '/' . implode('/', $parts));
    $root = realpath(PUBLIC_DIR);
    if ($real === false || $root === false || !is_file($real)) return null;
    if (!str_starts_with($real, $root . DIRECTORY_SEPARATOR)) return null;
    if (!$anyFile && !str_ends_with($real, '.html')) return null;
    return $real;
}

function send_html(int $status, string $html, string $cacheControl): never
{
    $etag = 'W/"' . substr(rtrim(strtr(base64_encode(sha1($html, true)), '+/', '-_'), '='), 0, 22) . '"';
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: ' . $cacheControl);
    header('ETag: ' . $etag);
    if ($status === 200 && trim(header_value('If-None-Match')) === $etag) {
        http_response_code(304);
        exit;
    }
    send_body($status, $html);
}

function not_found(): never
{
    $file = PUBLIC_DIR . '/404.html';
    if (is_file($file)) {
        // <base> : les chemins relatifs de la page d'erreur fonctionnent quelle que soit l'adresse demandée
        $html = str_replace('<head>', '<head><base href="/">', version_assets((string) file_get_contents($file), '/404.html'));
        send_html(404, $html, 'no-cache');
    }
    send_text(404, 'Page introuvable');
}

function serve_upload(string $path): never
{
    $file = upload_path($path);
    if (!$file || !is_file($file)) not_found();
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    $size = (int) filesize($file);
    $mtime = (int) filemtime($file);
    $etag = '"' . base_convert((string) $size, 10, 36) . '-' . base_convert((string) $mtime, 10, 36) . '"';
    header('Content-Type: ' . (MIME[$ext] ?? 'application/octet-stream'));
    header('Cache-Control: public, max-age=31536000, immutable');
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    if (trim(header_value('If-None-Match')) === $etag) {
        http_response_code(304);
        exit;
    }
    header('Content-Length: ' . $size);
    if (request_method() !== 'HEAD') readfile($file);
    exit;
}

/**
 * Médias des événements (photos, vidéos, films) : dossier « medias » à côté de public_html,
 * jamais effacé par un déploiement. Servis par PHP (Hostinger désactive symlink()), avec lecture
 * par morceaux (Range), indispensable pour avancer dans une vidéo et pour les iPhone ;
 * le CDN d'Hostinger les garde ensuite en cache (Cache-Control public).
 */
function serve_media(string $path): never
{
    $rel = substr($path, strlen('/medias/'));
    if (!preg_match('~^[\w-]+(/[\w.-]+)*\.(jpe?g|png|webp|mp4|pdf)$~i', $rel) || str_contains($rel, '..')) not_found();
    $root = realpath(MEDIA_DIR);
    $file = $root ? realpath($root . '/' . $rel) : false;
    if (!$file || !is_file($file) || !str_starts_with($file, $root . DIRECTORY_SEPARATOR)) not_found();

    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    $types = ['jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp', 'mp4' => 'video/mp4', 'pdf' => 'application/pdf'];
    $size = (int) filesize($file);
    $mtime = (int) filemtime($file);
    $etag = '"' . base_convert((string) $size, 10, 36) . '-' . base_convert((string) $mtime, 10, 36) . '"';
    header('Content-Type: ' . $types[$ext]);
    header('Accept-Ranges: bytes');
    header('Cache-Control: public, max-age=2592000');
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    if (trim(header_value('If-None-Match')) === $etag) { http_response_code(304); exit; }

    $start = 0;
    $end = $size - 1;
    $range = header_value('Range');
    if ($range !== '') {
        if (!preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $m) || ($m[1] === '' && $m[2] === '')) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            exit;
        }
        if ($m[1] === '') { $start = max(0, $size - (int) $m[2]); }
        else { $start = (int) $m[1]; if ($m[2] !== '') $end = min((int) $m[2], $size - 1); }
        if ($start > $end || $start >= $size) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            exit;
        }
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    }
    $length = $end - $start + 1;
    header('Content-Length: ' . $length);
    if (request_method() === 'HEAD') exit;
    @set_time_limit(0);
    while (ob_get_level()) ob_end_clean();
    $fh = fopen($file, 'rb');
    fseek($fh, $start);
    while ($length > 0 && !feof($fh) && !connection_aborted()) {
        $chunk = fread($fh, (int) min(1048576, $length));
        if ($chunk === false) break;
        echo $chunk;
        flush();
        $length -= strlen($chunk);
    }
    fclose($fh);
    exit;
}

/**
 * Document joint : téléchargé sous son nom d'origine, jamais exécuté ni interprété
 * (type imposé, nosniff, CSP « sandbox »). Les PDF s'ouvrent dans le navigateur.
 */
function serve_document(string $path): never
{
    $file = document_path($path);
    $doc = $file ? get_document($path) : null;
    if (!$doc || !is_file($file)) not_found();
    $size = (int) filesize($file);
    $etag = '"d' . base_convert((string) $size, 10, 36) . '-' . base_convert((string) filemtime($file), 10, 36) . '"';
    $name = $doc['name'];
    $ascii = preg_replace('/[^A-Za-z0-9 ._-]+/', '_', @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $name) ?: 'document') ?: 'document';
    header('Content-Type: ' . DOC_TYPES[$doc['ext']][0]);
    header('Content-Disposition: ' . ($doc['ext'] === 'pdf' ? 'inline' : 'attachment') . '; filename="' . $ascii . '"; filename*=UTF-8\'\'' . rawurlencode($name));
    header('Content-Security-Policy: sandbox');
    header('X-Content-Type-Options: nosniff');
    // Jamais gardé par le CDN : un document retiré du site doit cesser d'être téléchargeable aussitôt
    header('Cache-Control: private, no-cache');
    header('ETag: ' . $etag);
    if (trim(header_value('If-None-Match')) === $etag) { http_response_code(304); exit; }
    header('Content-Length: ' . $size);
    if (request_method() !== 'HEAD') {
        while (ob_get_level()) ob_end_clean();
        readfile($file);
    }
    exit;
}

function sitemap(): string
{
    $urls = [];
    $pages = [''];
    foreach (SECTIONS as $s) $pages[] = $s['page'];
    $pages[] = 'mentions-legales.html';
    foreach (array_unique($pages) as $p) {
        if ($p === '' || is_file(PUBLIC_DIR . '/' . $p)) $urls[] = '  <url><loc>' . esc_html(absolute_url('/' . $p)) . '</loc></url>';
    }
    foreach (public_articles() as $a) {
        $urls[] = '  <url><loc>' . esc_html(absolute_url('/article.html?id=' . rawurlencode($a['slug'])))
            . '</loc><lastmod>' . esc_html(substr((string) $a['date'], 0, 10)) . '</lastmod></url>';
    }
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n"
        . implode("\n", $urls) . "\n</urlset>\n";
}

function robots(): string
{
    // Adresse provisoire Hostinger : on ne la fait pas référencer
    if (!str_contains(site_url(), 'asso-slf.org')) return "User-agent: *\nDisallow: /\n";
    return "User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: " . absolute_url('/sitemap.xml') . "\n";
}

/** Prochains rendez-vous : 18 mai (restauration de l'indépendance, 1991) et 26 juin (indépendance, 1960). */
function rdv_block(): string
{
    $today = strtotime(date('Y-m-d'));
    $items = [];
    foreach ([[5, 18, 1991, 'Fête nationale du Somaliland', 'anniversaire de la restauration de l’indépendance, le 18 mai 1991'],
              [6, 26, 1960, 'Jour de l’indépendance', 'anniversaire de l’indépendance du 26 juin 1960']] as [$m, $d, $origin, $title, $what]) {
        $y = (int) date('Y');
        if (mktime(0, 0, 0, $m, $d, $y) < $today) $y++;
        $n = $y - $origin;
        $items[] = [mktime(0, 0, 0, $m, $d, $y), '<li class="rdv"><time datetime="' . sprintf('%04d-%02d-%02d', $y, $m, $d) . '"><span>' . $d . '</span>'
            . ($m === 5 ? 'mai' : 'juin') . ' ' . $y . '</time><div><strong>' . $title . '</strong><p>' . $n . '<sup>e</sup> ' . $what . '</p></div></li>'];
    }
    usort($items, static fn ($a, $b) => $a[0] <=> $b[0]);
    return '<ul class="rdv-list" style="list-style:none;padding:0">' . implode('', array_column($items, 1)) . '</ul>';
}

/** Date de mise à jour d'une page : le fichier lui-même, ou le plus récent article qu'elle affiche. */
function page_updated(string $page, ?array $pd): int
{
    $t = (int) @filemtime(PUBLIC_DIR . '/' . $page . '.html');
    $list = $pd['data']['articles'] ?? (isset($pd['data']['article']) && $pd['data']['article'] ? [$pd['data']['article']] : []);
    foreach ($list as $a) {
        $t = max($t, ts($a['updatedAt'] ?? null), ts($a['date'] ?? null));
    }
    return $t ?: time();
}

function date_fr(int $t): string
{
    static $mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    return date('j', $t) . ' ' . $mois[(int) date('n', $t) - 1] . ' ' . date('Y', $t);
}

/**
 * Anciennes adresses du site Joomla (asso-slf.org avant 2026) → nouvelles pages (redirection 301).
 * Joomla utilisait index.php?option=com_…, /index.php/rubrique/… ou des adresses « propres ».
 */
function joomla_redirect(string $path, string $query): ?string
{
    $isJoomla = $path === '/index.php' || str_starts_with($path, '/index.php/') || str_starts_with($path, '/component/')
        || preg_match('~^/(images/(stories|phocagallery)|media/|templates/|modules/|plugins/)~', $path);
    $hay = strtolower(rawurldecode($path . ' ' . $query));
    if (!$isJoomla) {
        // Adresse « propre » de l'ancien site : seulement si elle n'existe pas ici et ne ressemble à rien de connu
        if (pathinfo($path, PATHINFO_EXTENSION) !== '' || str_starts_with($path, '/admin') || str_starts_with($path, '/api')) return null;
        if (is_file(PUBLIC_DIR . $path . '.html')) return null;
    }
    $map = [
        'contact' => '/contact.html',
        'adhesion' => '/bulletin-adhesion.html', 'adherer' => '/bulletin-adhesion.html', 'bulletin' => '/bulletin-adhesion.html',
        'cotisation' => '/bulletin-adhesion.html', 'don' => '/bulletin-adhesion.html',
        'diplomatie' => '/diplomatie.html',
        'phoca' => '/en-images.html', 'galerie' => '/en-images.html', 'gallery' => '/en-images.html', 'photo' => '/en-images.html', 'images' => '/en-images.html',
        'video' => '/videos.html', 'radio' => '/medias.html', 'media' => '/medias.html',
        'liens' => '/liens-utiles.html', 'link' => '/liens-utiles.html',
        'qui-sommes' => '/association.html#qui-sommes-nous', 'presentation' => '/association.html', 'association' => '/association.html',
        'notre-but' => '/association.html#nos-missions', 'objectif' => '/association.html#nos-missions',
        'action' => '/actions-realisees.html',
        'actualit' => '/news.html', 'news' => '/news.html', 'article' => '/news.html', 'blog' => '/news.html',
        'somaliland' => '/connaitre-somaliland.html', 'histoire' => '/connaitre-somaliland.html',
    ];
    foreach ($map as $needle => $target) {
        if (str_contains($hay, $needle)) return $target;
    }
    return $isJoomla ? '/' : null;
}

function handle_page(): never
{
    $path = request_path();
    $m = request_method();
    if ($m !== 'GET' && $m !== 'HEAD') send_text(405, 'Méthode non autorisée');

    if ($path === '/sitemap.xml') send_text(200, sitemap(), 'application/xml; charset=utf-8', ['Cache-Control' => 'public, max-age=3600']);
    if ($path === '/robots.txt') send_text(200, robots(), 'text/plain; charset=utf-8', ['Cache-Control' => 'public, max-age=86400']);
    $query = (string) ($_SERVER['QUERY_STRING'] ?? '');
    $qs = $query !== '' ? '?' . $query : '';
    if (isset(LEGACY[$path])) redirect(LEGACY[$path] . (str_contains(LEGACY[$path], '#') ? '' : $qs), 301);
    $joomla = joomla_redirect($path, $query);
    if ($joomla !== null) redirect($joomla, 301);
    if ($path === '/admin') redirect('/admin/' . $qs, 301);
    if ($path === '/index.html') redirect('/' . $qs, 301);
    if (str_starts_with($path, '/uploads/')) serve_upload($path);
    if (str_starts_with($path, '/medias/')) serve_media($path);
    if (str_starts_with($path, '/fichiers/')) serve_document($path);

    $rel = str_ends_with($path, '/') ? $path . 'index.html' : $path;
    if (pathinfo($rel, PATHINFO_EXTENSION) === '') $rel .= '.html';
    $full = resolve_public($rel);
    if (!$full) not_found();

    $admin = session_key() !== null;
    $src = (string) file_get_contents($full);
    if (str_starts_with($rel, '/admin/')) {
        // Administration : jamais en cache ; redirection vers la connexion si besoin
        header('X-Robots-Tag: noindex, nofollow');
        if ($rel === '/admin/connexion.html') {
            if ($admin) redirect('/admin/');
        } elseif (!$admin) {
            redirect('/admin/connexion.html?suite=' . rawurlencode(basename($rel) . $qs));
        }
        send_html(200, version_assets($src, $rel), 'no-store');
    }
    [$html, $status] = render_page($src, basename($rel, '.html'), $admin);
    send_html($status, version_assets($html, $rel), $admin ? 'private, no-cache' : 'no-cache');
}
