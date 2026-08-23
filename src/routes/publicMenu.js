const express = require('express');

const router = express.Router();
const venueModel = require('../models/venueModel');
const itemModel = require('../models/itemModel');
const menuCache = require('../services/menuCache');
const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const { SERVICE_NAME } = require('../config/constants');

const LANG_COOKIE = 'menu_lang';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

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

function buildWorkingHours(workingHours, tt) {
  if (!workingHours) return [];
  return DAYS.filter((day) => workingHours[day] && String(workingHours[day]).trim()).map((day) => ({
    label: tt(`days.${day}`),
    hours: workingHours[day],
  }));
}

function buildMenuViewModel(venue, items, lang) {
  const tt = (key, params) => t(key, lang, params);

  const groups = itemModel.groupByCategory(items).map((group) => ({
    categoryId: group.categoryId,
    categoryName: lang === 'ru' ? (group.categoryNameRu || group.categoryNameUz) : (group.categoryNameUz || group.categoryNameRu),
    items: group.items.map((item) => ({
      id: item.id,
      name: pickLang(item, 'name', lang),
      description: pickLang(item, 'description', lang),
      price: item.price,
      currency: item.currency,
      photoThumbUrl: item.photo_thumb_url,
      tags: item.tags.map((tag) => ({ key: tag, label: tt(`tags.${tag}`) })),
      isAvailable: item.is_available,
    })),
  }));

  return {
    venueName: venue.name,
    venueSlug: venue.slug,
    groups,
    lang,
    t: tt,
    phone: venue.phone,
    address: venue.address,
    address2gisUrl: venue.address_2gis_url,
    instagramUrl: venue.instagram_url,
    telegramUrl: venue.telegram_url,
    workingHours: buildWorkingHours(venue.working_hours, tt),
    showPoweredBy: venue.show_powered_by,
    serviceName: SERVICE_NAME,
  };
}

router.get('/:slug', async (req, res, next) => {
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

    const cached = menuCache.get(slug, lang);
    if (cached) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(cached);
    }

    const items = await itemModel.listByVenueGrouped(venue.id);
    const viewModel = buildMenuViewModel(venue, items, lang);

    res.render('public/menu', viewModel, (err, html) => {
      if (err) return next(err);
      menuCache.set(slug, lang, html);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
