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
const VIEW_COOKIE_PREFIX = 'mv_';
const DAY_MS = 24 * 60 * 60 * 1000;

// Уникальный просмотр — не более одного засчитанного просмотра с одного браузера в день на
// заведение, независимо от того, сколько раз гость переключил категорию/язык или обновил
// страницу. Метка "уже посчитан сегодня" живёт в cookie конкретного заведения (не в общей БД
// визитов — для дневных счётчиков это не нужно), дата сравнивается по UTC, как и viewed_on в БД.
function shouldCountView(req, slug) {
  const today = new Date().toISOString().slice(0, 10);
  return (req.cookies && req.cookies[`${VIEW_COOKIE_PREFIX}${slug}`]) !== today;
}

function markViewCounted(res, slug) {
  const today = new Date().toISOString().slice(0, 10);
  res.cookie(`${VIEW_COOKIE_PREFIX}${slug}`, today, { httpOnly: true, sameSite: 'lax', maxAge: DAY_MS });
}

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

// Общие для всех страниц меню заведения поля (контакты, wifi, футер) — не зависят
// от того, какая категория сейчас открыта.
function buildVenueInfo(venue) {
  return {
    venueName: venue.name,
    venueSlug: venue.slug,
    phone: venue.phone,
    address: venue.address,
    address2gisUrl: venue.address_2gis_url,
    wifiSsid: venue.wifi_ssid,
    wifiPassword: venue.wifi_password,
    instagramUrl: venue.instagram_url,
    telegramUrl: venue.telegram_url,
    workingHours: venue.working_hours,
    showPoweredBy: venue.show_powered_by,
  };
}

function buildMetaDescription(venue, tt) {
  const base = tt('publicMenu.metaDescription', { venueName: venue.name });
  if (!venue.address) return base;
  return `${base} ${tt('publicMenu.metaDescriptionAddressSuffix', { address: venue.address })}`;
}

// JSON-LD (schema.org/Restaurant) — только из реально заполненных полей заведения, без
// придуманных данных (рейтинг, ценовая категория и т.п. мы не собираем и не добавляем).
function buildRestaurantJsonLd(venue, baseUrl) {
  const menuUrl = `${baseUrl}/menu/${venue.slug}`;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: venue.name,
    url: menuUrl,
    hasMenu: menuUrl,
    image: `${baseUrl}/og/${venue.slug}/image.png`,
  };
  if (venue.phone) data.telephone = venue.phone;
  if (venue.address) {
    data.address = { '@type': 'PostalAddress', streetAddress: venue.address };
  }
  const sameAs = [venue.instagram_url, venue.telegram_url].filter(Boolean);
  if (sameAs.length) data.sameAs = sameAs;
  return data;
}

// SEO/шеринг-метаданные. canonicalPath намеренно НЕ берётся из фактического пути запроса:
// /menu/:slug и /menu/:slug/:firstCategoryId рендерят абсолютно одинаковый HTML (и делят один
// ключ в menuCache — см. renderMenuPage), так что канонический URL обязан быть чистой функцией
// от (slug, activeCategoryId), а не от того, какой из двух путей запросили — иначе для одной и
// той же закэшированной страницы canonical "плавал" бы в зависимости от того, какой URL кэш
// заполнил первым.
function buildSeoInfo(venue, req, lang, tt, canonicalPath) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const canonicalUrl = `${baseUrl}${canonicalPath}`;
  const bareMenuUrl = `${baseUrl}/menu/${venue.slug}`;
  return {
    baseUrl,
    canonicalUrl,
    metaDescription: buildMetaDescription(venue, tt),
    ogImageUrl: `${baseUrl}/og/${venue.slug}/image.png`,
    ogLocale: lang === 'uz' ? 'uz_UZ' : 'ru_RU',
    hreflangLinks: [
      { lang: 'ru', href: `${bareMenuUrl}?lang=ru` },
      { lang: 'uz', href: `${bareMenuUrl}?lang=uz` },
      { lang: 'x-default', href: bareMenuUrl },
    ],
    restaurantJsonLd: buildRestaurantJsonLd(venue, baseUrl),
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
function buildMenuViewModel(venue, categories, activeCategory, items, lang, req) {
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

  // /menu/:slug и /menu/:slug/:firstCategoryId рендерят один и тот же HTML — оба каноникализируются
  // на голый URL заведения. Только у остальных категорий canonical указывает сам на себя.
  const isDefaultCategory = !activeCategory || !categories[0] || activeCategory.id === categories[0].id;
  const canonicalPath = isDefaultCategory ? `/menu/${venue.slug}` : `/menu/${venue.slug}/${activeCategory.id}`;

  return {
    categories: sidebarCategories,
    activeCategoryId: activeCategory ? activeCategory.id : null,
    group,
    lang,
    t: tt,
    ...buildVenueInfo(venue),
    ...buildSeoInfo(venue, req, lang, tt, canonicalPath),
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
      const viewModel = buildMenuViewModel(venue, [], null, [], lang, req);
      return res.render('public/menu', viewModel);
    }

    const parsedCategoryId = requestedCategoryId ? Number(requestedCategoryId) : null;
    const activeCategory = parsedCategoryId
      ? categories.find((category) => category.id === parsedCategoryId)
      : categories[0];

    if (!activeCategory) {
      return res.redirect(`/menu/${slug}/${categories[0].id}`);
    }

    if (shouldCountView(req, slug)) {
      markViewCounted(res, slug);
      venuePageViewModel.recordView(venue.id).catch((err) => {
        console.error('Не удалось записать просмотр меню', err);
      });
    }

    const cached = menuCache.get(slug, lang, activeCategory.id);
    if (cached) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(cached);
    }

    const items = await itemModel.listByCategory(activeCategory.id);
    const viewModel = buildMenuViewModel(venue, categories, activeCategory, items, lang, req);

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
