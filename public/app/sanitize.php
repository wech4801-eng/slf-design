<?php
/**
 * ASLF — Nettoyage du HTML des articles (liste blanche), côté serveur.
 *
 * Portage fidèle de public/assets/sanitize.js : le HTML est entièrement
 * reconstruit, seules les balises et attributs listés survivent.
 * C'est CE filtre qui protège les visiteurs : tout article est nettoyé ici
 * à chaque enregistrement, quoi que le navigateur ait envoyé.
 */
declare(strict_types=1);

const SAN_ALLOWED = [
    'p' => [], 'br' => [], 'strong' => [], 'em' => [], 'u' => [], 's' => [],
    'h2' => [], 'h3' => [], 'h4' => [],
    'ul' => [], 'ol' => [], 'li' => [],
    'blockquote' => [], 'hr' => [],
    'a' => ['href'], 'img' => ['src', 'alt'],
    'figure' => [], 'figcaption' => [],
    'iframe' => ['src'],
];
const SAN_DROP_WITH_CONTENT = ['script', 'style', 'noscript', 'template', 'object', 'embed', 'svg', 'math', 'head',
    'title', 'textarea', 'select', 'button', 'form', 'video', 'audio', 'canvas', 'xml'];
const SAN_SPACED = ['tr', 'td', 'th', 'section', 'article', 'header', 'footer', 'pre', 'table', 'dd', 'dt'];
const SAN_VOID = ['br', 'hr', 'img'];
const SAN_RENAME = ['h1' => 'h2', 'h5' => 'h4', 'h6' => 'h4', 'div' => 'p', 'b' => 'strong', 'i' => 'em', 'strike' => 's', 'del' => 's'];
const SAN_ALIGN = ['center', 'right', 'justify'];
const SAN_VIDEO_SRC = '~^https://(www\.youtube(-nocookie)?\.com/embed/[\w-]{6,20}|player\.vimeo\.com/video/\d{4,12})([?#][\w\-=&.%]*)?$~i';
const NBSP = "\u{00A0}";

function utf8(string $s): string
{
    return mb_check_encoding($s, 'UTF-8') ? $s : mb_convert_encoding($s, 'UTF-8', 'UTF-8');
}

function san_escape_text(string $s): string
{
    $s = preg_replace('/&(?!(?:[a-z]{2,8}|#\d{1,7}|#x[0-9a-f]{1,6});)/i', '&amp;', $s) ?? '';
    return str_replace(['<', '>'], ['&lt;', '&gt;'], $s);
}

function san_escape_attr(string $s): string
{
    return str_replace(['&', '"', '<', '>'], ['&amp;', '&quot;', '&lt;', '&gt;'], $s);
}

function san_decode_entities(string $s): string
{
    $cp = static function (int $n): string {
        if ($n <= 0 || $n > 0x10FFFF || ($n >= 0xD800 && $n <= 0xDFFF)) return ' ';
        $c = mb_chr($n, 'UTF-8');
        return $c === false ? ' ' : $c;
    };
    $s = preg_replace_callback('/&#x([0-9a-f]{1,6});?/i', static fn ($m) => $cp((int) hexdec($m[1])), $s) ?? '';
    $s = preg_replace_callback('/&#(\d{1,7});?/', static fn ($m) => $cp((int) $m[1]), $s) ?? '';
    return str_replace(['&nbsp;', '&quot;', '&apos;', '&lt;', '&gt;', '&amp;'], [NBSP, '"', "'", '<', '>', '&'], $s);
}

/** URL sûre : http(s), mailto/tel (liens seulement), ou chemin interne au site. */
function safe_url(mixed $raw, string $kind): string
{
    $url = preg_replace('/[\x{0000}-\x{0020}\x{007F}-\x{009F}]+/u', '', san_decode_entities(utf8((string) ($raw ?? '')))) ?? '';
    if ($url === '') return '';
    if (preg_match('~^https?://[^/]~i', $url)) return $url;
    if ($kind === 'href' && preg_match('~^(mailto|tel):[^<>"]+$~i', $url)) return $url;
    if (preg_match('~^(/(?!/)|\./|[\w-])[\w\-./%]*(\?[\w\-=&%.+]*)?(#[\w-]*)?$~', $url) && !str_contains($url, ':')) return $url;
    return '';
}

function san_parse_attrs(string $str): array
{
    $out = [];
    preg_match_all('/([^\s"\'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?/', $str, $all, PREG_SET_ORDER | PREG_UNMATCHED_AS_NULL);
    foreach ($all as $m) {
        $name = strtolower((string) $m[1]);
        if (!array_key_exists($name, $out)) $out[$name] = $m[2] ?? $m[3] ?? $m[4] ?? '';
    }
    return $out;
}

function san_build_tag(string $tag, array $attrs): ?string
{
    $html = '<' . $tag;
    if ($tag === 'a') {
        $href = safe_url($attrs['href'] ?? '', 'href');
        if ($href === '') return null;
        $html .= ' href="' . san_escape_attr($href) . '"';
        if (preg_match('~^https?:~i', $href)) $html .= ' target="_blank" rel="noopener noreferrer"';
    } elseif ($tag === 'img') {
        $src = safe_url($attrs['src'] ?? '', 'src');
        if ($src === '') return null;
        $alt = mb_substr(san_decode_entities((string) ($attrs['alt'] ?? '')), 0, 300);
        $html .= ' src="' . san_escape_attr($src) . '" alt="' . san_escape_attr($alt) . '" loading="lazy" decoding="async"';
    } elseif ($tag === 'iframe') {
        $src = trim(san_decode_entities((string) ($attrs['src'] ?? '')));
        if (!preg_match(SAN_VIDEO_SRC, $src)) return null;
        $html .= ' src="' . san_escape_attr($src) . '" loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="Vidéo"';
    }
    // Seule mise en forme conservée : l'alignement du texte
    if (preg_match('/^(p|h2|h3|h4|blockquote|figcaption|li)$/', $tag)) {
        $style = san_decode_entities((string) ($attrs['style'] ?? ''));
        $align = preg_match('/text-align\s*:\s*([a-z]+)/i', $style, $m) ? $m[1] : (string) ($attrs['align'] ?? '');
        $align = strtolower($align);
        if (in_array($align, SAN_ALIGN, true)) $html .= ' style="text-align:' . $align . '"';
    }
    return $html . '>';
}

/** Nettoie un fragment HTML et renvoie du HTML sûr. */
function sanitize_html(mixed $input): string
{
    if ($input === null || is_array($input) || is_object($input)) return '';
    $html = utf8((string) $input);
    if (strlen($html) > 2000000) $html = utf8(substr($html, 0, 2000000));
    $html = preg_replace(
        ['/<!--[\s\S]*?(?:-->|\z)/', '/<!\[CDATA\[[\s\S]*?(?:\]\]>|\z)/', '/<![^>]*>/', '/<\?[\s\S]*?(?:\?>|\z)/'],
        '', $html) ?? '';

    $out = [];
    $stack = [];
    $re = '/<\/?([a-zA-Z][\w:-]*)((?:\s+[^\s"\'>\/=]+(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s"\'=<>`]+))?)*)\s*\/?>/';
    $offset = 0;
    $last = 0;
    $dropUntil = null;
    $len = strlen($html);
    while ($offset < $len && preg_match($re, $html, $m, PREG_OFFSET_CAPTURE, $offset) === 1) {
        $raw = $m[0][0];
        $idx = $m[0][1];
        $offset = $idx + strlen($raw);
        $isClose = $raw[1] === '/';
        $tag = strtolower($m[1][0]);
        if ($dropUntil !== null) {
            if ($isClose && $tag === $dropUntil) { $dropUntil = null; $last = $offset; }
            continue;
        }
        if ($idx > $last) $out[] = san_escape_text(substr($html, $last, $idx - $last));
        $last = $offset;

        if (in_array($tag, SAN_DROP_WITH_CONTENT, true)) {
            if (!$isClose && !str_ends_with($raw, '/>')) $dropUntil = $tag;
            continue;
        }
        $tag = SAN_RENAME[$tag] ?? $tag;
        if (!array_key_exists($tag, SAN_ALLOWED)) {
            if (in_array($tag, SAN_SPACED, true)) $out[] = ' ';
            continue;
        }

        if ($isClose) {
            if (in_array($tag, SAN_VOID, true)) continue;
            $pos = array_search($tag, array_reverse($stack, true), true);
            if ($pos === false) continue;
            while (count($stack) > $pos) {
                $t = array_pop($stack);
                if ($t[0] !== '!') $out[] = '</' . $t . '>';
            }
            continue;
        }
        $built = san_build_tag($tag, san_parse_attrs((string) ($m[2][0] ?? '')));
        if ($built === null) {
            // Lien refusé : on garde son texte, et on ignore sa balise fermante
            if ($tag === 'a') $stack[] = '!a';
            elseif ($tag === 'iframe') $dropUntil = 'iframe';
            continue;
        }
        $out[] = $built;
        if ($tag === 'iframe') { $out[] = '</iframe>'; $dropUntil = 'iframe'; continue; }
        if (!in_array($tag, SAN_VOID, true)) $stack[] = $tag;
    }
    if ($dropUntil === null && $last < $len) $out[] = san_escape_text(substr($html, $last));
    while ($stack) {
        $t = array_pop($stack);
        if ($t[0] !== '!') $out[] = '</' . $t . '>';
    }

    $res = implode('', $out);
    $res = preg_replace('/<(p|h2|h3|h4|li|blockquote|strong|em|u|s)>(\s|&nbsp;|\x{00A0}|<br>)*<\/\1>/u', '', $res) ?? $res;
    $res = preg_replace('/(<br>\s*){3,}/', '<br><br>', $res) ?? $res;
    return trim($res);
}

/** Texte brut (résumés, temps de lecture). */
function to_text(mixed $html): string
{
    $s = utf8((string) ($html ?? ''));
    $s = preg_replace('/<(br|hr|\/p|\/h[2-4]|\/li|\/blockquote|\/figcaption)\b[^>]*>/i', ' ', $s) ?? '';
    $s = preg_replace('/<[^>]*>/', '', $s) ?? '';
    $s = san_decode_entities($s);
    return trim(preg_replace('/[\s\x{00A0}]+/u', ' ', $s) ?? '');
}
