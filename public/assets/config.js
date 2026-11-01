/**
 * ASLF — Rubriques et thèmes des articles.
 * Source unique partagée par le serveur, le site public et l'administration.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SLFConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tous les articles publiés apparaissent dans « Actualités » et sur l'accueil.
  // La rubrique indique en plus la page du site où l'article est rangé.
  const SECTIONS = [
    { key: 'news',                 label: 'Actualités',               page: 'news.html',                 help: 'Une nouvelle, un événement, un communiqué. C’est le choix habituel.' },
    { key: 'diplomatie',           label: 'Diplomatie',               page: 'diplomatie.html',           help: 'Relations internationales, reconnaissance du Somaliland.' },
    { key: 'actions-realisees',    label: 'Actions réalisées',        page: 'actions-realisees.html',    help: 'Ce que l’association a fait : collectes, aides, rencontres.' },
    { key: 'association',          label: 'L’association',            page: 'association.html',          help: 'Présentation de l’ASLF.' },
    { key: 'qui-sommes-nous',      label: 'Qui sommes-nous ?',        page: 'qui-sommes-nous.html',      help: 'Le bureau, les membres du comité.' },
    { key: 'notre-but',            label: 'Notre but',                page: 'notre-but.html',            help: 'Les missions et objectifs de l’association.' },
    { key: 'connaitre-somaliland', label: 'Connaître le Somaliland',  page: 'connaitre-somaliland.html', help: 'Histoire, géographie, culture du pays.' },
    { key: 'en-images',            label: 'En images',                page: 'en-images.html',            help: 'Un reportage surtout composé de photos.' },
    { key: 'videos',               label: 'Vidéos',                   page: 'videos.html',               help: 'Un article construit autour d’une vidéo.' },
    { key: 'radios',               label: 'Radios',                   page: 'radios.html',               help: 'Émissions, interviews audio.' },
    { key: 'medias',               label: 'Médias',                   page: 'medias.html',               help: 'Revue de presse, passages dans les médias.' },
    { key: 'bulletin-adhesion',    label: 'Bulletin d’adhésion',      page: 'bulletin-adhesion.html',    help: 'Informations pour devenir membre.' },
    { key: 'appel-cotisation',     label: 'Appel à cotisation',       page: 'appel-cotisation.html',     help: 'Rappel ou campagne de cotisation.' },
    { key: 'liens-utiles',         label: 'Liens utiles',             page: 'liens-utiles.html',         help: 'Sites et ressources recommandés.' },
    { key: 'contact',              label: 'Contact',                  page: 'contact.html',              help: 'Informations pratiques, horaires, adresse.' },
  ];

  // Thème : colore l'étiquette de la carte d'article (facultatif)
  const CATEGORIES = [
    { key: 'actions',     label: 'Actions & solidarité', tone: 'actions' },
    { key: 'diplomatie',  label: 'Diplomatie',           tone: 'diplomatie' },
    { key: 'evenement',   label: 'Événement',            tone: 'culture' },
    { key: 'communique',  label: 'Communiqué',           tone: 'actions' },
    { key: 'culture',     label: 'Culture & société',    tone: 'culture' },
    { key: 'education',   label: 'Éducation',            tone: 'education' },
    { key: 'humanitaire', label: 'Humanitaire & santé',  tone: 'actions' },
    { key: 'politique',   label: 'Politique',            tone: 'diplomatie' },
    { key: 'economie',    label: 'Économie',             tone: 'education' },
    { key: 'galerie',     label: 'Galerie photo',        tone: 'culture' },
    { key: 'video',       label: 'Vidéo',                tone: 'culture' },
    { key: 'radio',       label: 'Radio & audio',        tone: 'culture' },
  ];

  // Anciennes rubriques fusionnées dans « Actualités »
  const SECTION_ALIASES = { accueil: 'news' };

  const sectionByKey = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));
  const categoryByKey = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

  function section(key) { return sectionByKey[SECTION_ALIASES[key] || key] || sectionByKey.news; }
  function category(key) { return categoryByKey[key] || null; }

  return { SECTIONS, CATEGORIES, SECTION_ALIASES, section, category };
});
