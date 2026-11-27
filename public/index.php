<?php
/**
 * ASLF — Point d'entrée unique du site sur Hostinger (PHP 8.1+, SQLite).
 *
 * Les fichiers statiques (images, CSS, JS, polices) sont servis directement
 * par le serveur web ; tout le reste passe ici (voir .htaccess) :
 *   /api/…        → API (articles, contact, administration)
 *   /uploads/…    → photos envoyées depuis l'administration
 *   pages .html   → page avec les articles déjà intégrés
 */
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';
require __DIR__ . '/app/api.php';
require __DIR__ . '/app/render.php';

security_headers();
firewall();

// Entretien quotidien (corbeille, sauvegarde de la base) après l'envoi de la réponse
register_shutdown_function(static function (): void {
    if (function_exists('litespeed_finish_request')) litespeed_finish_request();
    elseif (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
    try { daily_maintenance(); } catch (Throwable $e) { log_error('entretien : ' . $e->getMessage()); }
});

if (str_starts_with(request_path(), '/api/')) handle_api();
handle_page();
