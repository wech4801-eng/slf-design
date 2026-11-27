<?php
/**
 * ASLF — Rubriques et thèmes des articles (côté serveur).
 * Doit rester identique à public/assets/config.js (vérifié par tests/coherence.test.js).
 */
declare(strict_types=1);

const SECTIONS = [
    ['key' => 'news',                 'label' => 'Actualités',              'page' => 'news.html'],
    ['key' => 'diplomatie',           'label' => 'Diplomatie',              'page' => 'diplomatie.html'],
    ['key' => 'actions-realisees',    'label' => 'Actions réalisées',       'page' => 'actions-realisees.html'],
    ['key' => 'association',          'label' => 'L’association',           'page' => 'association.html'],
    ['key' => 'connaitre-somaliland', 'label' => 'Connaître le Somaliland', 'page' => 'connaitre-somaliland.html'],
    ['key' => 'en-images',            'label' => 'En images',               'page' => 'en-images.html'],
    ['key' => 'videos',               'label' => 'Vidéos',                  'page' => 'videos.html'],
    ['key' => 'medias',               'label' => 'Médias',                  'page' => 'medias.html'],
    ['key' => 'bulletin-adhesion',    'label' => 'Adhérer / Faire un don',     'page' => 'bulletin-adhesion.html'],
    ['key' => 'liens-utiles',         'label' => 'Liens utiles',            'page' => 'liens-utiles.html'],
    ['key' => 'contact',              'label' => 'Contact',                 'page' => 'contact.html'],
];

const CATEGORIES = [
    ['key' => 'actions',     'label' => 'Actions & solidarité', 'tone' => 'actions'],
    ['key' => 'diplomatie',  'label' => 'Diplomatie',           'tone' => 'diplomatie'],
    ['key' => 'evenement',   'label' => 'Événement',            'tone' => 'culture'],
    ['key' => 'communique',  'label' => 'Communiqué',           'tone' => 'actions'],
    ['key' => 'culture',     'label' => 'Culture & société',    'tone' => 'culture'],
    ['key' => 'education',   'label' => 'Éducation',            'tone' => 'education'],
    ['key' => 'humanitaire', 'label' => 'Humanitaire & santé',  'tone' => 'actions'],
    ['key' => 'politique',   'label' => 'Politique',            'tone' => 'diplomatie'],
    ['key' => 'economie',    'label' => 'Économie',             'tone' => 'education'],
    ['key' => 'galerie',     'label' => 'Galerie photo',        'tone' => 'culture'],
    ['key' => 'video',       'label' => 'Vidéo',                'tone' => 'culture'],
    ['key' => 'radio',       'label' => 'Radio & audio',        'tone' => 'culture'],
];

const SECTION_ALIASES = ['accueil' => 'news', 'qui-sommes-nous' => 'association', 'notre-but' => 'association', 'appel-cotisation' => 'bulletin-adhesion', 'radios' => 'videos'];

function section_of(mixed $key): array
{
    $key = is_string($key) ? (SECTION_ALIASES[$key] ?? $key) : '';
    foreach (SECTIONS as $s) if ($s['key'] === $key) return $s;
    return SECTIONS[0];
}

function category_of(mixed $key): ?array
{
    if (!is_string($key) || $key === '') return null;
    foreach (CATEGORIES as $c) if ($c['key'] === $key) return $c;
    return null;
}
