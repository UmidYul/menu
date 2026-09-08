const express = require('express');

const router = express.Router();
const venueModel = require('../models/venueModel');
const photoService = require('../services/photoService');
const menuCache = require('../services/menuCache');

// Промт 2.5. Манифест PWA — свой на каждое заведение: гость ставит на домашний экран «Одессу MA»,
// а не «qr.menu». Роутер монтируется на /menu ДО publicMenuRoutes (см. src/app.js): иначе
// '/:slug/:categoryId' там перехватил бы '/:slug/manifest.webmanifest' как категорию.

// Значения цветов — те же, что у токенов --primary и --background в design-system.css.
// В манифесте CSS-переменные не работают, поэтому литералами; менять вместе с токенами.
const THEME_COLOR = '#c65d42';
const BACKGROUND_COLOR = '#f8f7f3';

// На домашнем экране под иконкой помещается немного — длинное название всё равно обрежется
// системой, но обрежется грубо. Режем сами, по границе слова.
const SHORT_NAME_MAX = 12;

function buildShortName(name) {
  const clean = String(name).trim();
  if (clean.length <= SHORT_NAME_MAX) return clean;
  const cut = clean.slice(0, SHORT_NAME_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 4 ? cut.slice(0, lastSpace) : cut).trim();
}

function serviceIcons() {
  return [
    { src: '/icons/app-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/app-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/app-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
}

function venueIcons(venueId, token) {
  return [
    { src: photoService.pwaIconUrl(venueId, token, '192'), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: photoService.pwaIconUrl(venueId, token, '512'), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: photoService.pwaIconUrl(venueId, token, 'maskable-512'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
}

// Ленивый догон для заведений, загрузивших логотип ДО появления этой функции: у них
// pwa_icons_token пуст, а логотип есть. Генерируем при первом запросе манифеста и запоминаем.
// Без этого фича не работала бы ни у одного существующего заведения, пока оно не загрузит
// логотип заново. Ошибка генерации не должна ломать манифест — просто отдадим иконку сервиса.
async function ensureIcons(venue) {
  if (venue.pwa_icons_token) return venue.pwa_icons_token;
  if (!venue.logo_url) return null;

  try {
    const buffer = await photoService.readLocalUpload(venue.logo_url);
    if (!buffer) return null;
    const token = await photoService.saveVenuePwaIcons(venue.id, buffer);
    await venueModel.updatePwaIconsToken(venue.id, token);
    return token;
  } catch (err) {
    console.error('pwa: не удалось догенерировать иконки заведения', venue.id, err);
    return null;
  }
}

router.get('/:slug/manifest.webmanifest', async (req, res, next) => {
  try {
    const { slug } = req.params;

    const host = req.get('host') || '';
    const cached = menuCache.getManifest(host, slug);
    if (cached) {
      res.type('application/manifest+json');
      return res.send(cached);
    }

    const venue = await venueModel.findPublicBySlug(slug);
    // Черновик для гостя не существует вовсе (та же логика, что и у страницы меню), а значит
    // и устанавливать нечего. Приостановленное заведение манифест отдаёт: гость мог поставить
    // приложение раньше, и подменять ему иконку на «не найдено» смысла нет — при открытии
    // он увидит заглушку, потому что HTML всегда идёт из сети, когда сеть есть.
    if (!venue || venue.status === 'draft') return res.status(404).json({ error: 'not_found' });

    const token = await ensureIcons(venue);
    const base = req.customDomain && req.customDomain.venueId === venue.id
      ? '/'
      : `/menu/${venue.slug}`;
    const manifest = {
      name: venue.name,
      short_name: buildShortName(venue.name),
      // Метка источника, чтобы в аналитике заходы из установленного приложения было видно
      // отдельно от QR и обычных ссылок (см. миграцию на menu_events.source).
      //
      // Промт 3.7: на своём домене меню живёт в КОРНЕ, поэтому там и стартовая страница, и
      // область — '/'. Оставить здесь путь сервиса значило бы, что установленное с
      // menu.mykafe.uz приложение открывается по адресу, которого на этом домене нет.
      start_url: `${base}?src=pwa`,
      // Область — только меню этого заведения: ссылка на лендинг или чужое меню откроется
      // в обычном браузере, а не внутри «приложения заведения». На своём домене чужого меню
      // не бывает вовсе, так что областью становится весь домен.
      scope: base,
      display: 'standalone',
      orientation: 'portrait',
      lang: venue.lang_default || 'ru',
      dir: 'ltr',
      theme_color: THEME_COLOR,
      background_color: BACKGROUND_COLOR,
      icons: token ? venueIcons(venue.id, token) : serviceIcons(),
    };

    const json = JSON.stringify(manifest);
    menuCache.setManifest(venue.id, host, slug, json);

    res.type('application/manifest+json');
    return res.send(json);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
