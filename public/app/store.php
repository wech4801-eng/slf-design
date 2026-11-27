<?php
/**
 * ASLF — Stockage : articles, membres, messages, photos, sauvegardes.
 *
 * Tout est enregistré sur le serveur Hostinger, dans la base SQLite
 * aslf-data/aslf.sqlite ; les photos dans aslf-data/uploads/AAAA/MM/.
 * Rien de ce que le navigateur envoie n'est conservé sans contrôle.
 */
declare(strict_types=1);

const STATUSES = ['publié', 'brouillon', 'planifié'];
const VIEW_WINDOW = 6 * 3600;
const MAX_UPLOAD = 10 * 1024 * 1024;
const UPLOAD_URL_RE = '~^/uploads/(\d{4})/(\d{2})/([\w-]{8,40})\.(webp|jpg|png|gif)$~';
const MEMBER_FIELDS = ['prenom' => 80, 'nom' => 80, 'email' => 160, 'telephone' => 40, 'ville' => 80, 'statut' => 40, 'cotisation' => 40, 'adhesion' => 10, 'notes' => 2000];
const SUBJECTS = [
    'adhesion' => 'Adhésion', 'don' => 'Don', 'benevole' => 'Bénévolat', 'projet' => 'Projet', 'presse' => 'Presse',
    'partenariat' => 'Partenariat', 'information' => 'Demande d’information', 'autre' => 'Autre',
];
const EMAIL_RE = '/^[^\s@]+@[^\s@]+\.[^\s@]+$/u';

// ── Utilitaires ──────────────────────────────────────────────────────────────
/** Texte brut d'une ligne (titres, résumés) : balises retirées, espaces normalisés. */
function plain(mixed $v, int $max): string
{
    return mb_substr(to_text(str_clean($v, $max * 2)), 0, $max);
}

function count_words(string $s): int
{
    return $s === '' ? 0 : count(array_filter(explode(' ', $s), static fn ($w) => $w !== ''));
}

function slugify(mixed $s): string
{
    $s = mb_strtolower(str_clean($s, 200));
    if (class_exists('Normalizer')) {
        $s = (string) Normalizer::normalize($s, Normalizer::FORM_D);
        $s = preg_replace('/\p{Mn}+/u', '', $s) ?? '';
    } else {
        $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
        if ($t !== false) $s = strtolower($t);
    }
    $s = preg_replace("/['’]/u", '-', $s) ?? '';
    $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
    return rtrim(substr(trim($s, '-'), 0, 80), '-');
}

/** Chemin d'image interne normalisé en absolu (« images/x.jpg » → « /images/x.jpg »). */
function clean_image_url(mixed $v): string
{
    $u = safe_url(str_clean($v, 2000), 'src');
    if ($u === '') return '';
    if (preg_match('~^https?:~i', $u) || str_starts_with($u, '/')) return $u;
    return '/' . preg_replace('~^\./~', '', $u);
}

function clean_content_urls(string $html): string
{
    // Chemins relatifs du site → absolus, pour un affichage correct depuis /admin/
    return preg_replace('~(<img src=")(?!https?:|/)(?:\./)?([^"]+)"~', '$1/$2"', $html) ?? $html;
}

function parse_video(mixed $url): ?array
{
    $s = str_clean($url, 500);
    if (preg_match('~(?:youtube(?:-nocookie)?\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/)|youtu\.be/)([\w-]{6,20})~i', $s, $m)) {
        return ['type' => 'youtube', 'url' => 'https://www.youtube-nocookie.com/embed/' . $m[1]];
    }
    if (preg_match('~vimeo\.com/(?:video/)?(\d{4,12})~i', $s, $m)) {
        return ['type' => 'vimeo', 'url' => 'https://player.vimeo.com/video/' . $m[1]];
    }
    return null;
}

function json_text(mixed $v): string
{
    return (string) json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

// ── Articles ─────────────────────────────────────────────────────────────────
function is_public(?array $a, ?int $now = null): bool
{
    if (!$a || !empty($a['deletedAt'])) return false;
    if (($a['status'] ?? '') === 'publié') return true;
    return ($a['status'] ?? '') === 'planifié' && !empty($a['publishAt']) && ts($a['publishAt']) <= ($now ?? time());
}

/** Date affichée et utilisée pour le tri : date de publication réelle. */
function article_date(array $a): ?string
{
    if (($a['status'] ?? '') === 'planifié' && !empty($a['publishAt'])) return $a['publishAt'];
    return $a['publishedAt'] ?? $a['createdAt'] ?? $a['updatedAt'] ?? null;
}

function article_from_row(array $r): array
{
    $a = json_decode((string) $r['data'], true);
    if (!is_array($a)) $a = [];
    $a['views'] = (int) $r['views'];
    return $a;
}

/** Tous les articles (corbeille comprise), lus une fois par requête. */
function all_articles(bool $fresh = false): array
{
    static $cache = null;
    if ($cache === null || $fresh) {
        $cache = array_map('article_from_row', db()->query('SELECT data, views FROM articles')->fetchAll());
    }
    return $cache;
}

function get_article(string $idOrSlug): ?array
{
    $st = db()->prepare('SELECT data, views FROM articles WHERE id = ? OR slug = ? ORDER BY (id = ?) DESC LIMIT 1');
    $st->execute([$idOrSlug, $idOrSlug, $idOrSlug]);
    $r = $st->fetch();
    return $r ? article_from_row($r) : null;
}

function unique_slug(string $base, string $id): string
{
    $root = $base !== '' ? $base : 'article';
    $st = db()->prepare('SELECT slug FROM articles WHERE (slug = ? OR slug LIKE ?) AND id <> ?');
    $st->execute([$root, $root . '-%', $id]);
    $taken = array_flip($st->fetchAll(PDO::FETCH_COLUMN));
    $slug = $root;
    for ($n = 2; isset($taken[$slug]); $n++) $slug = $root . '-' . $n;
    return $slug;
}

/**
 * Valide et nettoie un article reçu de l'éditeur. Rien de ce que le navigateur
 * envoie n'est conservé sans contrôle (vues, dates, identifiant…).
 */
function normalize_article(array $input, ?array $existing): array
{
    $now = now_iso();
    $status = in_array($input['status'] ?? null, STATUSES, true) ? $input['status'] : 'brouillon';
    $content = clean_content_urls(sanitize_html($input['content'] ?? ''));
    $title = plain($input['title'] ?? '', 200);
    if ($title === '') $title = 'Sans titre';
    $id = $existing['id'] ?? new_id('art');
    $publishAt = $status === 'planifié' ? iso_or_null($input['publishAt'] ?? null) : null;
    if ($status === 'planifié' && !$publishAt) $status = 'brouillon';
    $coverImage = clean_image_url($input['coverImage'] ?? '');
    $slugBase = slugify($input['slug'] ?? '');
    if ($slugBase === '') $slugBase = slugify($title);

    $tags = [];
    foreach (is_array($input['tags'] ?? null) ? $input['tags'] : [] as $t) {
        $t = str_clean($t, 40);
        if ($t !== '' && count($tags) < 12) $tags[] = $t;
    }
    $gallery = [];
    foreach (is_array($input['gallery'] ?? null) ? $input['gallery'] : [] as $g) {
        $g = clean_image_url($g);
        if ($g !== '' && count($gallery) < 80) $gallery[] = $g;
    }
    $videos = [];
    foreach (is_array($input['videos'] ?? null) ? $input['videos'] : [] as $v) {
        $parsed = parse_video(is_array($v) ? ($v['url'] ?? '') : $v);
        if ($parsed && count($videos) < 10) $videos[] = $parsed;
    }
    $category = category_of($input['categoryKey'] ?? '');
    $author = str_clean($input['author'] ?? '', 80);

    $a = [
        'id' => $id,
        'slug' => unique_slug($slugBase, $id),
        'title' => $title,
        'chapeau' => plain($input['chapeau'] ?? '', 600),
        'content' => $content,
        'coverImage' => $coverImage,
        'coverThumb' => $coverImage !== '' ? clean_image_url($input['coverThumb'] ?? '') : '',
        'coverAlt' => plain($input['coverAlt'] ?? '', 200),
        'section' => section_of($input['section'] ?? '')['key'],
        'categoryKey' => $category ? $category['key'] : '',
        'tags' => $tags,
        'author' => $author !== '' ? $author : 'Rédaction ASLF',
        'status' => $status,
        'publishAt' => $publishAt,
        'seoTitle' => plain($input['seoTitle'] ?? '', 80),
        'metaDesc' => plain($input['metaDesc'] ?? '', 220),
        'gallery' => $gallery,
        'videos' => $videos,
        'attachments' => clean_attachments($input['attachments'] ?? []),
        'words' => count_words(to_text($content)),
        'views' => (int) ($existing['views'] ?? 0),
        'createdAt' => $existing['createdAt'] ?? $now,
        'updatedAt' => $now,
        'publishedAt' => $existing['publishedAt'] ?? null,
        'deletedAt' => $existing['deletedAt'] ?? null,
    ];
    if ($a['status'] === 'publié' && !$a['publishedAt']) $a['publishedAt'] = $now;
    return $a;
}

function article_summary(array $a, bool $admin): array
{
    $sec = section_of($a['section'] ?? '');
    $cat = category_of($a['categoryKey'] ?? '');
    $chapeau = (string) ($a['chapeau'] ?? '');
    $s = [
        'id' => $a['id'],
        'slug' => $a['slug'] ?? $a['id'],
        'title' => $a['title'] ?? 'Sans titre',
        'chapeau' => $chapeau !== '' ? $chapeau : mb_substr(to_text($a['content'] ?? ''), 0, 220),
        'coverImage' => $a['coverImage'] ?? '',
        'coverThumb' => ($a['coverThumb'] ?? '') ?: ($a['coverImage'] ?? ''),
        'coverAlt' => $a['coverAlt'] ?? '',
        'section' => $sec['key'],
        'sectionLabel' => $sec['label'],
        'sectionPage' => $sec['page'],
        'categoryKey' => $cat ? $cat['key'] : '',
        'categoryLabel' => $cat ? $cat['label'] : $sec['label'],
        'tone' => $cat ? $cat['tone'] : 'actions',
        'author' => ($a['author'] ?? '') ?: 'Rédaction ASLF',
        'date' => article_date($a),
        'readMinutes' => max(1, (int) round(((int) ($a['words'] ?? 0) + count_words($chapeau)) / 200)),
        'views' => (int) ($a['views'] ?? 0),
    ];
    if ($admin) {
        $s['status'] = $a['status'] ?? 'brouillon';
        $s['publishAt'] = $a['publishAt'] ?? null;
        $s['updatedAt'] = $a['updatedAt'] ?? null;
        $s['deletedAt'] = $a['deletedAt'] ?? null;
        $s['isPublic'] = is_public($a);
    }
    return $s;
}

function article_full(array $a, bool $admin): array
{
    return article_summary($a, $admin) + [
        'content' => $a['content'] ?? '',
        'tags' => $a['tags'] ?? [],
        'gallery' => $a['gallery'] ?? [],
        'videos' => $a['videos'] ?? [],
        'attachments' => $a['attachments'] ?? [],
        'seoTitle' => $a['seoTitle'] ?? '',
        'metaDesc' => $a['metaDesc'] ?? '',
        'createdAt' => $a['createdAt'] ?? null,
        'updatedAt' => $a['updatedAt'] ?? null,
    ];
}

function by_date_desc(array $x, array $y): int
{
    return ts(article_date($y)) <=> ts(article_date($x));
}

/** Articles visibles du public, du plus récent au plus ancien (résumés). */
function public_articles(): array
{
    static $list = null;
    if ($list === null) {
        $now = time();
        $pub = array_values(array_filter(all_articles(), static fn ($a) => is_public($a, $now)));
        usort($pub, 'by_date_desc');
        $list = array_map(static fn ($a) => article_summary($a, false), $pub);
    }
    return $list;
}

function admin_articles(): array
{
    $list = all_articles();
    usort($list, static fn ($x, $y) => ts($y['updatedAt'] ?? null) <=> ts($x['updatedAt'] ?? null));
    return array_map(static fn ($a) => article_summary($a, true), $list);
}

function write_article(array $a, bool $insert): void
{
    $params = [
        ':id' => $a['id'], ':slug' => $a['slug'], ':status' => $a['status'], ':section' => $a['section'],
        ':publish_at' => $a['publishAt'], ':published_at' => $a['publishedAt'], ':created_at' => $a['createdAt'],
        ':updated_at' => $a['updatedAt'], ':deleted_at' => $a['deletedAt'], ':views' => (int) $a['views'],
    ];
    $data = $a;
    unset($data['views']);
    $params[':data'] = json_text($data);
    $sql = $insert
        ? 'INSERT INTO articles (id, slug, status, section, publish_at, published_at, created_at, updated_at, deleted_at, views, data)
           VALUES (:id, :slug, :status, :section, :publish_at, :published_at, :created_at, :updated_at, :deleted_at, :views, :data)'
        : 'UPDATE articles SET slug = :slug, status = :status, section = :section, publish_at = :publish_at,
           published_at = :published_at, created_at = :created_at, updated_at = :updated_at, deleted_at = :deleted_at,
           views = :views, data = :data WHERE id = :id';
    db()->prepare($sql)->execute($params);
}

function save_article(array $input, ?string $id = null): array
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $existing = null;
        if ($id !== null) {
            $st = $pdo->prepare('SELECT data, views FROM articles WHERE id = ?');
            $st->execute([$id]);
            $row = $st->fetch();
            if (!$row) throw http_error(404, 'Article introuvable.');
            $existing = article_from_row($row);
        }
        $a = normalize_article($input, $existing);
        write_article($a, $existing === null);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    return article_full($a, true);
}

function set_article_deleted(string $id, bool $deleted): void
{
    $a = get_article($id);
    if (!$a || $a['id'] !== $id) throw http_error(404, 'Article introuvable.');
    $a['deletedAt'] = $deleted ? now_iso() : null;
    write_article($a, false);
}

function destroy_article(string $id): void
{
    $st = db()->prepare('DELETE FROM articles WHERE id = ?');
    $st->execute([$id]);
    if ($st->rowCount() === 0) throw http_error(404, 'Article introuvable.');
}

/** Compte une vue par visiteur (adresse IP) et par article, toutes les 6 heures au plus. */
function count_view(string $id): ?int
{
    $a = get_article($id);
    if (!$a || $a['id'] !== $id || !is_public($a)) return null;
    $pdo = db();
    $key = hash('sha256', client_ip() . '|' . $id);
    $now = time();
    $st = $pdo->prepare('SELECT at FROM view_log WHERE key = ?');
    $st->execute([$key]);
    $last = $st->fetchColumn();
    if ($last === false || $now - (int) $last > VIEW_WINDOW) {
        $pdo->beginTransaction();
        if ($last === false) $pdo->prepare('INSERT INTO view_log (key, at) VALUES (?, ?)')->execute([$key, $now]);
        else $pdo->prepare('UPDATE view_log SET at = ? WHERE key = ?')->execute([$now, $key]);
        $pdo->prepare('UPDATE articles SET views = views + 1 WHERE id = ?')->execute([$id]);
        $pdo->commit();
        if (random_int(1, 200) === 1) $pdo->prepare('DELETE FROM view_log WHERE at < ?')->execute([$now - VIEW_WINDOW]);
        return $a['views'] + 1;
    }
    return $a['views'];
}

/** Premier démarrage : import des articles d'origine (public/seed-articles.json). */
function seed_articles(PDO $pdo): void
{
    $file = PUBLIC_DIR . '/seed-articles.json';
    $list = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
    if (!is_array($list)) return;
    if ((int) $pdo->query('SELECT COUNT(*) FROM articles')->fetchColumn() > 0) return;
    $fix = static fn ($u) => is_string($u) ? (preg_replace('~(images/livret/\d+)\.png~', '$1.webp', $u) ?? $u) : $u;
    $pdo->beginTransaction();
    foreach ($list as $raw) {
        if (!is_array($raw) || empty($raw['id']) || !preg_match('/^[\w-]{1,120}$/', (string) $raw['id'])) continue;
        $raw['coverImage'] = $fix($raw['coverImage'] ?? '');
        $raw['gallery'] = array_map($fix, is_array($raw['gallery'] ?? null) ? $raw['gallery'] : []);
        $raw['content'] = $fix($raw['content'] ?? '');
        $existing = [
            'id' => (string) $raw['id'],
            'views' => (int) ($raw['views'] ?? 0),
            'createdAt' => iso_or_null($raw['createdAt'] ?? null),
            'publishedAt' => iso_or_null($raw['publishedAt'] ?? null),
            'deletedAt' => null,
        ];
        $a = normalize_article($raw, $existing);
        $a['updatedAt'] = iso_or_null($raw['updatedAt'] ?? null) ?? $a['updatedAt'];
        $a['createdAt'] = $existing['createdAt'] ?? $a['updatedAt'];
        $a['publishedAt'] = $existing['publishedAt'] ?? ($a['status'] === 'publié' ? $a['createdAt'] : null);
        write_article($a, true);
    }
    $pdo->commit();
}

// ── Membres ──────────────────────────────────────────────────────────────────
function normalize_member(array $input, ?array $existing): array
{
    $m = ['id' => $existing['id'] ?? new_id('mbr')];
    foreach (MEMBER_FIELDS as $k => $max) $m[$k] = str_clean($input[$k] ?? '', $max);
    if ($m['nom'] === '' && $m['prenom'] === '' && !empty($input['name'])) $m['nom'] = str_clean($input['name'], 80);
    if ($m['prenom'] === '' && $m['nom'] === '') throw http_error(400, 'Indiquez au moins un nom ou un prénom.');
    if ($m['email'] !== '' && !preg_match(EMAIL_RE, $m['email'])) throw http_error(400, 'Cette adresse e-mail ne semble pas correcte.');
    if ($m['adhesion'] !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $m['adhesion'])) $m['adhesion'] = '';
    $m['createdAt'] = $existing['createdAt'] ?? now_iso();
    $m['updatedAt'] = now_iso();
    return $m;
}

function list_members(): array
{
    $rows = db()->query('SELECT data FROM members')->fetchAll(PDO::FETCH_COLUMN);
    $list = array_values(array_filter(array_map(static fn ($d) => json_decode((string) $d, true), $rows), 'is_array'));
    $coll = class_exists('Collator') ? new Collator('fr_FR') : null;
    $cmp = static fn (string $x, string $y): int => $coll ? (int) $coll->compare($x, $y) : strcasecmp($x, $y);
    usort($list, static fn ($a, $b) => $cmp((string) ($a['nom'] ?? ''), (string) ($b['nom'] ?? '')) ?: $cmp((string) ($a['prenom'] ?? ''), (string) ($b['prenom'] ?? '')));
    return $list;
}

function save_member(array $input, ?string $id = null): array
{
    $existing = null;
    if ($id !== null) {
        $st = db()->prepare('SELECT data FROM members WHERE id = ?');
        $st->execute([$id]);
        $d = $st->fetchColumn();
        if ($d === false) throw http_error(404, 'Membre introuvable.');
        $existing = json_decode((string) $d, true) ?: ['id' => $id];
    }
    $m = normalize_member($input, $existing);
    $params = [$m['nom'], $m['prenom'], $m['createdAt'], $m['updatedAt'], json_text($m), $m['id']];
    $sql = $existing
        ? 'UPDATE members SET nom = ?, prenom = ?, created_at = ?, updated_at = ?, data = ? WHERE id = ?'
        : 'INSERT INTO members (nom, prenom, created_at, updated_at, data, id) VALUES (?, ?, ?, ?, ?, ?)';
    db()->prepare($sql)->execute($params);
    return $m;
}

function delete_member(string $id): void
{
    $st = db()->prepare('DELETE FROM members WHERE id = ?');
    $st->execute([$id]);
    if ($st->rowCount() === 0) throw http_error(404, 'Membre introuvable.');
}

// ── Messages du formulaire de contact ────────────────────────────────────────
function add_message(array $input): array
{
    $sujet = is_string($input['sujet'] ?? null) && isset(SUBJECTS[$input['sujet']]) ? $input['sujet'] : 'autre';
    $m = [
        'id' => new_id('msg'),
        'nom' => plain($input['nom'] ?? '', 120),
        'email' => str_clean($input['email'] ?? '', 160),
        'telephone' => str_clean($input['telephone'] ?? '', 40),
        'sujet' => $sujet,
        'message' => str_clean($input['message'] ?? '', 5000),
        'createdAt' => now_iso(),
        'lu' => false,
    ];
    if ($m['nom'] === '') throw http_error(400, 'Indiquez votre nom.');
    if (!preg_match(EMAIL_RE, $m['email'])) throw http_error(400, 'Indiquez une adresse e-mail valide pour que nous puissions vous répondre.');
    if (mb_strlen($m['message']) < 5) throw http_error(400, 'Écrivez votre message.');
    db()->prepare('INSERT INTO messages (id, created_at, lu, data) VALUES (?, ?, 0, ?)')->execute([$m['id'], $m['createdAt'], json_text($m)]);
    return $m;
}

function list_messages(): array
{
    $rows = db()->query('SELECT data, lu FROM messages ORDER BY created_at DESC')->fetchAll();
    $out = [];
    foreach ($rows as $r) {
        $m = json_decode((string) $r['data'], true);
        if (!is_array($m)) continue;
        $m['lu'] = (bool) $r['lu'];
        $m['sujetLabel'] = SUBJECTS[$m['sujet'] ?? ''] ?? 'Autre';
        $out[] = $m;
    }
    return $out;
}

function unread_messages(): int
{
    return (int) db()->query('SELECT COUNT(*) FROM messages WHERE lu = 0')->fetchColumn();
}

function set_message_read(string $id, bool $lu): void
{
    $chk = db()->prepare('SELECT 1 FROM messages WHERE id = ?');
    $chk->execute([$id]);
    if (!$chk->fetchColumn()) throw http_error(404, 'Message introuvable.');
    db()->prepare('UPDATE messages SET lu = ? WHERE id = ?')->execute([$lu ? 1 : 0, $id]);
}

function delete_message(string $id): void
{
    $st = db()->prepare('DELETE FROM messages WHERE id = ?');
    $st->execute([$id]);
    if ($st->rowCount() === 0) throw http_error(404, 'Message introuvable.');
}

// ── Photos ───────────────────────────────────────────────────────────────────
function image_type(string $buf): ?string
{
    if (strlen($buf) < 12) return null;
    if (str_starts_with($buf, "\xFF\xD8\xFF")) return 'jpg';
    if (str_starts_with($buf, "\x89PNG")) return 'png';
    if (str_starts_with($buf, 'GIF8')) return 'gif';
    if (substr($buf, 0, 4) === 'RIFF' && substr($buf, 8, 4) === 'WEBP') return 'webp';
    return null;
}

function save_upload(string $buf): array
{
    if ($buf === '') throw http_error(400, 'Fichier vide.');
    if (strlen($buf) > MAX_UPLOAD) throw http_error(413, 'Photo trop lourde (10 Mo maximum).');
    $ext = image_type($buf);
    if (!$ext) throw http_error(415, 'Ce fichier n’est pas une photo (JPG, PNG, WebP ou GIF).');
    ensure_data_dirs();
    $yyyy = date('Y');
    $mm = date('m');
    $dir = UPLOADS_DIR . "/$yyyy/$mm";
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    $name = rtrim(strtr(base64_encode(random_bytes(12)), '+/', '-_'), '=');
    $file = "$dir/$name.$ext";
    if (file_put_contents($file, $buf, LOCK_EX) !== strlen($buf)) throw new RuntimeException('Écriture de la photo impossible');
    @chmod($file, 0644);
    return ['url' => "/uploads/$yyyy/$mm/$name.$ext", 'size' => strlen($buf)];
}

function upload_path(string $url): ?string
{
    return preg_match(UPLOAD_URL_RE, $url, $m) ? UPLOADS_DIR . "/{$m[1]}/{$m[2]}/{$m[3]}.{$m[4]}" : null;
}

/** Photo → articles qui l'utilisent (couverture, galerie ou texte). */
function upload_usage(): array
{
    $used = [];
    $add = static function (mixed $url, array $a) use (&$used): void {
        if (!is_string($url) || !preg_match(UPLOAD_URL_RE, $url)) return;
        foreach ($used[$url] ?? [] as $x) if ($x['id'] === $a['id']) return;
        $used[$url][] = ['id' => $a['id'], 'title' => $a['title'] ?? '', 'deleted' => !empty($a['deletedAt'])];
    };
    foreach (all_articles() as $a) {
        $add($a['coverImage'] ?? '', $a);
        $add($a['coverThumb'] ?? '', $a);
        foreach ($a['gallery'] ?? [] as $u) $add($u, $a);
        if (preg_match_all('~src="(/uploads/[^"]+)"~', (string) ($a['content'] ?? ''), $mm)) {
            foreach ($mm[1] as $u) $add($u, $a);
        }
    }
    return $used;
}

function list_uploads(): array
{
    $used = upload_usage();
    $out = [];
    if (!is_dir(UPLOADS_DIR)) return $out;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(UPLOADS_DIR, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if (!$f->isFile()) continue;
        $rel = str_replace('\\', '/', substr($f->getPathname(), strlen(UPLOADS_DIR)));
        $url = '/uploads' . $rel;
        if (!preg_match(UPLOAD_URL_RE, $url)) continue;
        $out[] = ['url' => $url, 'size' => $f->getSize(), 'date' => gmdate('Y-m-d\TH:i:s.000\Z', $f->getMTime()), 'usedBy' => $used[$url] ?? []];
    }
    usort($out, static fn ($a, $b) => strcmp($b['date'], $a['date']));
    return $out;
}

function delete_upload(string $url): void
{
    $file = upload_path($url);
    if (!$file) throw http_error(400, 'Photo inconnue.');
    if (!empty(upload_usage()[$url])) throw http_error(409, 'Cette photo est utilisée dans un article : retirez-la de l’article d’abord.');
    if (!is_file($file)) throw http_error(404, 'Photo introuvable.');
    unlink($file);
}

// ── Documents joints aux articles (PDF, Word, Excel, PowerPoint, OpenOffice, texte) ──
const MAX_DOCUMENT = 20 * 1024 * 1024;
const DOC_TYPES = [
    'pdf' => ['application/pdf', 'PDF'],
    'doc' => ['application/msword', 'Word'],
    'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word'],
    'odt' => ['application/vnd.oasis.opendocument.text', 'Texte'],
    'xls' => ['application/vnd.ms-excel', 'Excel'],
    'xlsx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel'],
    'ods' => ['application/vnd.oasis.opendocument.spreadsheet', 'Tableur'],
    'ppt' => ['application/vnd.ms-powerpoint', 'PowerPoint'],
    'pptx' => ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint'],
    'odp' => ['application/vnd.oasis.opendocument.presentation', 'Présentation'],
    'txt' => ['text/plain; charset=utf-8', 'Texte'],
    'csv' => ['text/csv; charset=utf-8', 'Tableau CSV'],
];
const DOC_URL_RE = '~^/fichiers/(\d{4})/(\d{2})/([\w-]{8,40})\.(pdf|docx?|odt|xlsx?|ods|pptx?|odp|txt|csv)$~';

/** Le contenu du fichier correspond-il vraiment à son extension ? (un .pdf doit être un PDF, etc.) */
function document_matches(string $buf, string $ext): bool
{
    return match ($ext) {
        'pdf' => str_starts_with($buf, '%PDF-'),
        'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp' => str_starts_with($buf, "PK\x03\x04"),
        'doc', 'xls', 'ppt' => str_starts_with($buf, "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"),
        'txt', 'csv' => !str_contains($buf, "\0"),
        default => false,
    };
}

/** Nom de fichier lisible et sans danger (« Compte-rendu AG 2026.pdf »). */
function clean_file_name(string $name, string $ext): string
{
    $base = pathinfo(str_replace('\\', '/', $name), PATHINFO_FILENAME);
    $base = preg_replace('/[\x00-\x1F\x7F"\/\\\\<>:|?*]+/u', ' ', utf8($base)) ?? '';
    $base = trim(preg_replace('/\s+/u', ' ', $base) ?? '', " .");
    return mb_substr($base !== '' ? $base : 'document', 0, 120) . '.' . $ext;
}

function save_document(string $buf, string $originalName): array
{
    if ($buf === '') throw http_error(400, 'Fichier vide.');
    if (strlen($buf) > MAX_DOCUMENT) throw http_error(413, 'Document trop lourd (20 Mo maximum).');
    $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    if (!isset(DOC_TYPES[$ext])) throw http_error(415, 'Format non accepté. Formats possibles : PDF, Word, Excel, PowerPoint, OpenOffice, texte.');
    if (!document_matches($buf, $ext)) throw http_error(415, 'Ce fichier ne correspond pas à son format (' . strtoupper($ext) . ') : il est peut-être abîmé.');
    ensure_data_dirs();
    $yyyy = date('Y');
    $mm = date('m');
    $dir = DOCS_DIR . "/$yyyy/$mm";
    if (!is_dir($dir)) mkdir($dir, 0750, true);
    $id = rtrim(strtr(base64_encode(random_bytes(12)), '+/', '-_'), '=');
    $file = "$dir/$id.$ext";
    if (file_put_contents($file, $buf, LOCK_EX) !== strlen($buf)) throw new RuntimeException('Écriture du document impossible');
    @chmod($file, 0640);
    $doc = ['url' => "/fichiers/$yyyy/$mm/$id.$ext", 'name' => clean_file_name($originalName, $ext), 'size' => strlen($buf), 'ext' => $ext];
    db()->prepare('INSERT INTO documents (url, name, size, ext, created_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$doc['url'], $doc['name'], $doc['size'], $ext, now_iso()]);
    return $doc + ['label' => DOC_TYPES[$ext][1]];
}

function document_path(string $url): ?string
{
    return preg_match(DOC_URL_RE, $url, $m) ? DOCS_DIR . "/{$m[1]}/{$m[2]}/{$m[3]}.{$m[4]}" : null;
}

function get_document(string $url): ?array
{
    $st = db()->prepare('SELECT url, name, size, ext, created_at FROM documents WHERE url = ?');
    $st->execute([$url]);
    $d = $st->fetch();
    return $d ? ['url' => $d['url'], 'name' => $d['name'], 'size' => (int) $d['size'], 'ext' => $d['ext'], 'label' => DOC_TYPES[$d['ext']][1] ?? 'Document'] : null;
}

/** Pièces jointes d'un article : seules les entrées qui correspondent à un document réellement envoyé sont gardées. */
function clean_attachments(mixed $list): array
{
    $out = [];
    foreach (is_array($list) ? $list : [] as $item) {
        $url = is_array($item) ? (string) ($item['url'] ?? '') : (string) $item;
        if (!preg_match(DOC_URL_RE, $url) || isset($out[$url])) continue;
        $doc = get_document($url);
        if ($doc) $out[$url] = $doc;
        if (count($out) >= 20) break;
    }
    return array_values($out);
}

function document_usage(): array
{
    $used = [];
    foreach (all_articles() as $a) {
        foreach ($a['attachments'] ?? [] as $d) {
            $used[$d['url']][] = ['id' => $a['id'], 'title' => $a['title'] ?? '', 'deleted' => !empty($a['deletedAt'])];
        }
    }
    return $used;
}

function list_documents(): array
{
    $used = document_usage();
    $rows = db()->query('SELECT url, name, size, ext, created_at FROM documents ORDER BY created_at DESC')->fetchAll();
    return array_map(static fn ($d) => [
        'url' => $d['url'], 'name' => $d['name'], 'size' => (int) $d['size'], 'ext' => $d['ext'],
        'label' => DOC_TYPES[$d['ext']][1] ?? 'Document', 'date' => $d['created_at'], 'usedBy' => $used[$d['url']] ?? [],
    ], $rows);
}

function delete_document(string $url): void
{
    $file = document_path($url);
    if (!$file || !get_document($url)) throw http_error(404, 'Document introuvable.');
    if (!empty(document_usage()[$url])) throw http_error(409, 'Ce document est joint à un article : retirez-le de l’article d’abord.');
    if (bulletin_in_use($url)) throw http_error(409, 'Ce document est le bulletin d’adhésion du site : changez-le d’abord dans Réglages.');
    db()->prepare('DELETE FROM documents WHERE url = ?')->execute([$url]);
    if (is_file($file)) unlink($file);
}

// ── Entretien quotidien : corbeille et sauvegarde automatique ────────────────
function daily_maintenance(): void
{
    $today = date('Y-m-d');
    if (setting_get('maintenance', '') === $today) return;
    setting_set('maintenance', $today);

    // Corbeille : les articles supprimés depuis plus de 30 jours disparaissent
    $limit = gmdate('Y-m-d\TH:i:s.000\Z', time() - TRASH_DAYS * 86400);
    db()->prepare('DELETE FROM articles WHERE deleted_at IS NOT NULL AND deleted_at < ?')->execute([$limit]);
    db()->prepare('DELETE FROM throttle WHERE at < ?')->execute([time() - 86400]);
    db()->prepare('DELETE FROM sessions WHERE exp < ?')->execute([time()]);
    purge_firewall();

    // Copie complète de la base, une par jour, gardée 30 jours
    ensure_data_dirs();
    $target = BACKUPS_DIR . "/aslf-$today.sqlite";
    if (!is_file($target)) {
        try {
            db()->exec('VACUUM INTO ' . db()->quote($target));
        } catch (Throwable) {
            db()->exec('PRAGMA wal_checkpoint(FULL)');
            @copy(DB_FILE, $target);
        }
        @chmod($target, 0640);
    }
    foreach (glob(BACKUPS_DIR . '/aslf-*.sqlite') ?: [] as $f) {
        if (preg_match('/aslf-(\d{4}-\d{2}-\d{2})\.sqlite$/', $f, $m) && strtotime($m[1]) < time() - BACKUP_DAYS * 86400) @unlink($f);
    }
}

function last_backup(): ?string
{
    $files = glob(BACKUPS_DIR . '/aslf-*.sqlite') ?: [];
    sort($files);
    return $files && preg_match('/aslf-(\d{4}-\d{2}-\d{2})\.sqlite$/', (string) end($files), $m) ? $m[1] : null;
}

/** Sauvegarde téléchargeable : articles, membres, messages (JSON), base complète et photos. */
function stream_backup(): never
{
    @set_time_limit(600);
    $day = date('Y-m-d');
    $articles = all_articles();
    $json = static fn ($v) => (string) json_encode($v, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);

    if (!class_exists('ZipArchive')) {
        send_json(200, ['date' => now_iso(), 'articles' => $articles, 'members' => list_members(), 'messages' => list_messages()], [
            'Content-Disposition' => "attachment; filename=\"sauvegarde-aslf-$day.json\"",
        ]);
    }
    ensure_data_dirs();
    $tmp = DATA_DIR . '/tmp';
    if (!is_dir($tmp)) mkdir($tmp, 0750, true);
    foreach (glob("$tmp/*") ?: [] as $old) if (filemtime($old) < time() - 3600) @unlink($old);
    $zipFile = "$tmp/sauvegarde-" . bin2hex(random_bytes(6)) . '.zip';
    $snapshot = "$tmp/base-" . bin2hex(random_bytes(6)) . '.sqlite';

    $zip = new ZipArchive();
    if ($zip->open($zipFile, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new RuntimeException('Création du fichier ZIP impossible');
    $zip->addFromString('LISEZ-MOI.txt', "Sauvegarde du site ASLF du $day\n\n"
        . "Contenu :\n- articles.json : les articles\n- membres.json : les membres\n- messages.json : les messages reçus\n"
        . "- aslf.sqlite : la base de données complète du site\n- uploads/ : les photos envoyées depuis l'administration\n"
        . "- fichiers/ : les documents joints aux articles (leurs noms d'origine sont dans aslf.sqlite et articles.json)\n\n"
        . "Pour restaurer : voir la section « Restaurer une sauvegarde » du guide DEPLOIEMENT-HOSTINGER.md.\n");
    $zip->addFromString('articles.json', $json($articles));
    $zip->addFromString('membres.json', $json(list_members()));
    $zip->addFromString('messages.json', $json(list_messages()));
    $withDb = false;
    try {
        db()->exec('VACUUM INTO ' . db()->quote($snapshot));
        $withDb = $zip->addFile($snapshot, 'aslf.sqlite');
    } catch (Throwable) {
        // La base complète est facultative : les fichiers JSON suffisent à tout reconstruire
    }
    foreach (list_uploads() as $u) {
        $file = upload_path($u['url']);
        if ($file && is_file($file)) $zip->addFile($file, ltrim($u['url'], '/'));
    }
    foreach (list_documents() as $d) {
        $file = document_path($d['url']);
        if ($file && is_file($file)) $zip->addFile($file, ltrim($d['url'], '/'));
    }
    $zip->close();
    if ($withDb) @unlink($snapshot);

    http_response_code(200);
    header('Content-Type: application/zip');
    header("Content-Disposition: attachment; filename=\"sauvegarde-aslf-$day.zip\"");
    header('Cache-Control: no-store');
    header('Content-Length: ' . filesize($zipFile));
    while (ob_get_level()) ob_end_clean();
    readfile($zipFile);
    @unlink($zipFile);
    exit;
}
