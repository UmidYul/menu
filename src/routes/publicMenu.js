const express = require('express');

const router = express.Router();
const venueModel = require('../models/venueModel');
const itemModel = require('../models/itemModel');
const categoryModel = require('../models/categoryModel');
const venuePageViewModel = require('../models/venuePageViewModel');
const menuCache = require('../services/menuCache');
const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const { SERVICE_NAME } = require('../config/constants');

const LANG_COOKIE = 'menu_lang';

// Приоритет: явный выбор в query (?lang=) > cookie из прошлого визита > lang_default заведения.
function resolveLang(req, venueLangDefault) {
  if (SUPPORTED_LANGS.includes(req.query.lang)) return req.query.lang;
  const cookieLang = req.cookies && req.cookies[LANG_COOKIE];
  if (SUPPORTED_LANGS.includes(cookieLang)) return cookieLang;
  return venueLangDefault === 'uz' ? 'uz' : DEFAULT_LANG;
}

// Выбирает нужное языковое поле у строки (например name_ru/name_uz), с фолбэком
// на другой язык, если конкретное поле пустое.
function pickLang(row, baseField, lang) {
  const otherLang = lang === 'ru' ? 'uz' : 'ru';
  const primary = row[`${baseField}_${lang}`];
  if (primary && String(primary).trim()) return primary;
  const fallback = row[`${baseField}_${otherLang}`];
  return fallback || '';
}

const MAP_BBOX_DELTA = 0.004;

function buildMapEmbedUrl(latitude, longitude) {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  const bbox = [lon - MAP_BBOX_DELTA, lat - MAP_BBOX_DELTA, lon + MAP_BBOX_DELTA, lat + MAP_BBOX_DELTA].join('%2C');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`;
}

// Общие для всех страниц меню заведения поля (контакты, карта, wifi, футер) — не зависят
// от того, какая категория сейчас открыта.
function buildVenueInfo(venue) {
  return {
    venueName: venue.name,
    venueSlug: venue.slug,
    phone: venue.phone,
    address: venue.address,
    address2gisUrl: venue.address_2gis_url,
    latitude: venue.latitude,
    longitude: venue.longitude,
    mapEmbedUrl: buildMapEmbedUrl(venue.latitude, venue.longitude),
    wifiSsid: venue.wifi_ssid,
    wifiPassword: venue.wifi_password,
    instagramUrl: venue.instagram_url,
    telegramUrl: venue.telegram_url,
    showPoweredBy: venue.show_powered_by,
    serviceName: SERVICE_NAME,
  };
}

function buildItemViewModel(item, lang, tt) {
  const description = pickLang(item, 'description', lang);
  const composition = pickLang(item, 'composition', lang);
  const extraTagCount = item.tags.filter((tag) => tag !== 'new').length;
  return {
    id: item.id,
    name: pickLang(item, 'name', lang),
    description,
    composition,
    calories: item.calories,
    price: item.price,
    oldPrice: item.old_price,
    discountPercent: item.old_price ? Math.round((1 - item.price / item.old_price) * 100) : null,
    currency: item.currency,
    photoThumbUrl: item.photo_thumb_url,
    tags: item.tags.map((tag) => ({ key: tag, label: tt(`tags.${tag}`) })),
    isAvailable: item.is_available,
    hasDetails: !!(composition || item.calories),
    // Есть ли что показать в hover/tap-раскрытии карточки — если нет, карточка не должна
    // реагировать на hover анимацией раскрытия (нечего раскрывать).
    hasReveal: !!(description || composition || item.calories || extraTagCount > 0),
  };
}

// Каждая категория — отдельная страница (/menu/:slug/:categoryId), а не секция на одной большой
// странице. buildMenuViewModel собирает: лёгкий список всех категорий (для сайдбара) + позиции
// только текущей открытой категории.
function buildMenuViewModel(venue, categories, activeCategory, items, lang) {
  const tt = (key, params) => t(key, lang, params);

  const sidebarCategories = categories.map((category) => ({
    id: category.id,
    name: lang === 'ru' ? (category.name_ru || category.name_uz) : (category.name_uz || category.name_ru),
  }));

  const group = activeCategory
    ? {
        categoryId: activeCategory.id,
        categoryName: lang === 'ru' ? (activeCategory.name_ru || activeCategory.name_uz) : (activeCategory.name_uz || activeCategory.name_ru),
        items: items.map((item) => buildItemViewModel(item, lang, tt)),
      }
    : null;

  return {
    categories: sidebarCategories,
    activeCategoryId: activeCategory ? activeCategory.id : null,
    group,
    lang,
    t: tt,
    ...buildVenueInfo(venue),
  };
}

async function renderMenuPage(req, res, next, requestedCategoryId) {
  try {
    const { slug } = req.params;

    const venue = await venueModel.findPublicBySlug(slug);
    if (!venue) {
      const lang = SUPPORTED_LANGS.includes(req.query.lang) ? req.query.lang : DEFAULT_LANG;
      return res.status(404).render('public/menu-not-found', { lang, t: (key, params) => t(key, lang, params) });
    }

    const lang = resolveLang(req, venue.lang_default);
    if (SUPPORTED_LANGS.includes(req.query.lang)) {
      res.cookie(LANG_COOKIE, lang, { httpOnly: false, sameSite: 'lax' });
    }

    if (!venue.is_active) {
      return res.status(200).render('public/menu-unavailable', {
        venueName: venue.name,
        lang,
        t: (key, params) => t(key, lang, params),
      });
    }

    const categories = await categoryModel.listByVenue(venue.id);

    if (categories.length === 0) {
      const viewModel = buildMenuViewModel(venue, [], null, [], lang);
      return res.render('public/menu', viewModel);
    }

    const parsedCategoryId = requestedCategoryId ? Number(requestedCategoryId) : null;
    const activeCategory = parsedCategoryId
      ? categories.find((category) => category.id === parsedCategoryId)
      : categories[0];

    if (!activeCategory) {
      return res.redirect(`/menu/${slug}/${categories[0].id}`);
    }

    venuePageViewModel.recordView(venue.id).catch((err) => {
      console.error('Не удалось записать просмотр меню', err);
    });

    const cached = menuCache.get(slug, lang, activeCategory.id);
    if (cached) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(cached);
    }

    const items = await itemModel.listByCategory(activeCategory.id);
    const viewModel = buildMenuViewModel(venue, categories, activeCategory, items, lang);

    res.render('public/menu', viewModel, (err, html) => {
      if (err) return next(err);
      menuCache.set(slug, lang, activeCategory.id, html);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    });
  } catch (err) {
    next(err);
  }
}

router.get('/:slug', (req, res, next) => renderMenuPage(req, res, next, null));
router.get('/:slug/:categoryId', (req, res, next) => renderMenuPage(req, res, next, req.params.categoryId));

module.exports = router;
