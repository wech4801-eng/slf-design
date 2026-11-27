<?php
/**
 * ASLF — Réglages du site modifiables depuis l'espace de gestion :
 *   - alerte e-mail à chaque message du formulaire de contact ;
 *   - liens HelloAsso (adhésion et don en ligne) ;
 *   - bulletin d'adhésion PDF (envoyé comme document joint).
 * Tant qu'un lien ou le bulletin n'est pas renseigné, rien n'apparaît sur le site.
 */
declare(strict_types=1);

const DEFAULT_ALERT_EMAIL = 'somalilande.france@gmail.com';

function site_settings(): array
{
    $bulletin = (string) setting_get('bulletin_url', '');
    return [
        'alerteActive' => setting_get('alerte_active', '1') === '1',
        'alerteEmail' => setting_get('alerte_email', DEFAULT_ALERT_EMAIL),
        'helloassoAdhesion' => setting_get('helloasso_adhesion', ''),
        'helloassoDon' => setting_get('helloasso_don', ''),
        'bulletin' => $bulletin !== '' ? get_document($bulletin) : null,
    ];
}

function clean_helloasso(mixed $url): string
{
    $url = str_clean($url, 500);
    if ($url === '') return '';
    if (!preg_match('~^https://(www\.)?helloasso\.com/[\w\-./%?=&]+$~i', $url)) {
        throw http_error(400, 'Le lien doit être une adresse HelloAsso, par exemple https://www.helloasso.com/associations/…');
    }
    return $url;
}

function save_site_settings(array $in): array
{
    if (array_key_exists('alerteEmail', $in)) {
        $email = str_clean($in['alerteEmail'], 160);
        if ($email !== '' && !preg_match(EMAIL_RE, $email)) throw http_error(400, 'L’adresse e-mail des alertes ne semble pas correcte.');
        setting_set('alerte_email', $email);
    }
    if (array_key_exists('alerteActive', $in)) setting_set('alerte_active', !empty($in['alerteActive']) ? '1' : '0');
    if (array_key_exists('helloassoAdhesion', $in)) setting_set('helloasso_adhesion', clean_helloasso($in['helloassoAdhesion']));
    if (array_key_exists('helloassoDon', $in)) setting_set('helloasso_don', clean_helloasso($in['helloassoDon']));
    if (array_key_exists('bulletin', $in)) {
        $url = str_clean($in['bulletin'], 200);
        if ($url !== '') {
            $doc = preg_match(DOC_URL_RE, $url) ? get_document($url) : null;
            if (!$doc || $doc['ext'] !== 'pdf') throw http_error(400, 'Le bulletin doit être un document PDF envoyé sur le site.');
        }
        setting_set('bulletin_url', $url);
    }
    return site_settings();
}

/** Bulletin choisi dans les réglages : il ne doit pas être supprimé. */
function bulletin_in_use(string $url): bool
{
    return $url !== '' && setting_get('bulletin_url', '') === $url;
}

function send_alert(string $subject, string $body, string $replyTo = ''): bool
{
    if (setting_get('alerte_active', '1') !== '1') return false;
    $to = (string) setting_get('alerte_email', DEFAULT_ALERT_EMAIL);
    if ($to === '' || !preg_match(EMAIL_RE, $to)) return false;
    $host = preg_replace('/^www\./', '', (string) parse_url(site_url(), PHP_URL_HOST)) ?: 'localhost';
    $headers = [
        'From' => "Site ASLF <no-reply@$host>",
        'MIME-Version' => '1.0',
        'Content-Type' => 'text/plain; charset=UTF-8',
        'Content-Transfer-Encoding' => '8bit',
    ];
    // Adresse déjà validée (aucun espace ni retour à la ligne possible)
    if ($replyTo !== '' && preg_match(EMAIL_RE, $replyTo)) $headers['Reply-To'] = $replyTo;
    $ok = @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, $headers);
    if (!$ok) log_error('alerte e-mail : envoi impossible vers ' . $to);
    return (bool) $ok;
}

/** Alerte e-mail à chaque nouveau message du formulaire de contact. */
function notify_new_message(array $m): void
{
    // Messages des tests automatiques (domaine réservé example.org) : pas d'alerte
    if (str_ends_with(strtolower((string) $m['email']), '@example.org')) return;
    $label = SUBJECTS[$m['sujet']] ?? 'Autre';
    $body = "Nouveau message reçu sur le site de l'association.\n\n"
        . "De : {$m['nom']}\nE-mail : {$m['email']}\n"
        . ($m['telephone'] !== '' ? "Téléphone : {$m['telephone']}\n" : '')
        . "Sujet : $label\n\n{$m['message']}\n\n"
        . 'Répondez directement à cet e-mail, ou lisez le message dans l’espace de gestion : ' . site_url() . "/admin/messages.html\n";
    send_alert("Nouveau message sur le site ASLF : $label", $body, (string) $m['email']);
}

function send_alert_test(): bool
{
    if (setting_get('alerte_active', '1') !== '1') throw http_error(400, 'Les alertes sont désactivées : cochez « Recevoir une alerte » puis enregistrez.');
    return send_alert('Test de l’alerte du site ASLF', "Ceci est un message de test envoyé depuis Réglages.\nLes nouveaux messages du formulaire de contact arriveront ainsi à cette adresse.\n\n" . site_url() . "/admin/messages.html\n");
}

/** Bouton principal et première étape de la page d'adhésion, selon que le bulletin PDF est en ligne ou non. */
function bulletin_parts(): array
{
    $doc = site_settings()['bulletin'];
    $icon = '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>';
    if ($doc) {
        return [
            '<a href="' . esc_html($doc['url']) . '" class="btn-download" target="_blank" rel="noopener">' . $icon . ' Télécharger le bulletin d’adhésion (PDF)</a>',
            "<h3>Téléchargez le bulletin</h3>
            <p>Cliquez sur le bouton ci-dessus pour ouvrir le bulletin d’adhésion (PDF, une page), puis imprimez-le.</p>",
        ];
    }
    return [
        '<a href="contact.html" class="btn-download">Nous écrire pour adhérer</a>',
        "<h3>Contactez-nous</h3>
            <p>Écrivez-nous grâce au <a href=\"contact.html\" style=\"color:var(--green);font-weight:600\">formulaire de contact</a> en choisissant le sujet « Adhésion » : nous vous envoyons le bulletin d’adhésion.</p>",
    ];
}

/** Bloc « adhésion en ligne » de la page Adhérer / Faire un don (vide tant que rien n'est renseigné). */
function adhesion_block(): string
{
    $s = site_settings();
    $links = [];
    if ($s['helloassoAdhesion'] !== '') $links[] = '<a href="' . esc_html($s['helloassoAdhesion']) . '" target="_blank" rel="noopener">Adhérer en ligne (HelloAsso)</a>';
    if ($s['helloassoDon'] !== '') $links[] = '<a href="' . esc_html($s['helloassoDon']) . '" target="_blank" rel="noopener">Faire un don en ligne (HelloAsso)</a>';
    if (!$links) return '';
    return "<div class=\"content-card\" id=\"en-ligne\">\n      <h2 style=\"font-family:var(--font-display);color:var(--green-dark);margin-bottom:12px;font-size:22px;\">Adhérer ou donner</h2>\n"
        . '      <div class="adhesion-en-ligne">' . implode('', $links) . "</div>\n    </div>";
}
