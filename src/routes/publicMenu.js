const express = require('express');

const router = express.Router();
const venueModel = require('../models/venueModel');
const itemModel = require('../models/itemModel');
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

// Общие для всей страницы меню заведения поля (профиль, контакты, wifi, футер).
function buildVenueInfo(venue, lang) {
  return {
    venueName: venue.name,
    venueSlug: venue.slug,
    phone: venue.phone,
    email: venue.email,
    address: venue.address,
    address2gisUrl: venue.address_2gis_url,
    wifiSsid: venue.wifi_ssid,
    wifiPassword: venue.wifi_password,
    instagramUrl: venue.instagram_url,
    telegramUrl: venue.telegram_url,
    workingHours: venue.working_hours,
    showPoweredBy: venue.show_powered_by,
    logoUrl: venue.logo_thumb_url || null,
    coverUrl: venue.cover_url || null,
    description: pickLang(venue, 'description', lang),
    cuisine: pickLang(venue, 'cuisine', lang),
    categoryLabel: pickLang(venue, 'category_label', lang),
    district: pickLang(venue, 'district', lang),
    rating: venue.rating === null || venue.rating === undefined ? null : Number(venue.rating),
    reviewCount: venue.review_count === null || venue.review_count === undefined ? null : Number(venue.review_count),
  };
}

function buildMetaDescription(venue, tt) {
  const base = tt('publicMenu.metaDescription', { venueName: venue.name });
  if (!venue.address) return base;
  return `${base} ${tt('publicMenu.metaDescriptionAddressSuffix', { address: venue.address })}`;
}

// JSON-LD (schema.org/Restaurant) — только из реально заполненных полей заведения, без
// придуманных данных.
function buildRestaurantJsonLd(venue, baseUrl, lang) {
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
  if (venue.email) data.email = venue.email;
  if (venue.address) {
    data.address = { '@type': 'PostalAddress', streetAddress: venue.address };
  }
  const cuisine = pickLang(venue, 'cuisine', lang);
  if (cuisine) data.servesCuisine = cuisine;
  if (venue.rating !== null && venue.rating !== undefined) {
    data.aggregateRating = { '@type': 'AggregateRating', ratingValue: Number(venue.rating) };
    if (venue.review_count !== null && venue.review_count !== undefined) {
      data.aggregateRating.reviewCount = Number(venue.review_count);
    }
  }
  const sameAs = [venue.instagram_url, venue.telegram_url].filter(Boolean);
  if (sameAs.length) data.sameAs = sameAs;
  return data;
}

// SEO/шеринг-метаданные. Меню теперь всегда одна страница со всеми категориями (категория в URL
// — только якорь для начального скролла на клиенте), так что канонический URL всегда голый URL
// заведения, независимо от того, какой из /menu/:slug или /menu/:slug/:categoryId запросили.
function buildSeoInfo(venue, req, lang, tt) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const bareMenuUrl = `${baseUrl}/menu/${venue.slug}`;
  return {
    baseUrl,
    canonicalUrl: bareMenuUrl,
    metaDescription: buildMetaDescription(venue, tt),
    ogImageUrl: `${baseUrl}/og/${venue.slug}/image.png`,
    ogLocale: lang === 'uz' ? 'uz_UZ' : 'ru_RU',
    hreflangLinks: [
      { lang: 'ru', href: `${bareMenuUrl}?lang=ru` },
      { lang: 'uz', href: `${bareMenuUrl}?lang=uz` },
      { lang: 'x-default', href: bareMenuUrl },
    ],
    restaurantJsonLd: buildRestaurantJsonLd(venue, baseUrl, lang),
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

// Вся видимая часть меню собирается одним запросом (все категории заведения сразу), чтобы лента
// категорий, scroll-spy и поиск по всему меню работали на одной странице без перезагрузки.
// Категории без единой позиции сами не попадают в выборку (INNER JOIN в listByVenueGrouped).
function buildMenuViewModel(venue, groupedRows, lang, req) {
  const tt = (key, params) => t(key, lang, params);

  const groups = itemModel.groupByCategory(groupedRows).map((group) => ({
    categoryId: group.categoryId,
    categoryName: lang === 'ru' ? (group.categoryNameRu || group.categoryNameUz) : (group.categoryNameUz || group.categoryNameRu),
    items: group.items.map((item) => buildItemViewModel(item, lang, tt)),
  }));

  // Теги для панели фильтров — только те, что реально встречаются хотя бы у одной позиции
  // этого заведения ("new" — маркетинговый бейдж, а не признак блюда, в фильтр не идёт).
  const tagSet = new Set();
  groups.forEach((group) => group.items.forEach((item) => item.tags.forEach((tag) => {
    if (tag.key !== 'new') tagSet.add(tag.key);
  })));
  const availableTags = Array.from(tagSet).map((key) => ({ key, label: tt(`tags.${key}`) }));

  return {
    groups,
    availableTags,
    lang,
    t: tt,
    ...buildVenueInfo(venue, lang),
    ...buildSeoInfo(venue, req, lang, tt),
  };
}

async function renderMenuPage(req, res, next) {
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

    if (shouldCountView(req, slug)) {
      markViewCounted(res, slug);
      venuePageViewModel.recordView(venue.id).catch((err) => {
        console.error('Не удалось записать просмотр меню', err);
      });
    }

    const cached = menuCache.get(slug, lang);
    if (cached) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(cached);
    }

    const rows = await itemModel.listByVenueGrouped(venue.id);
    const viewModel = buildMenuViewModel(venue, rows, lang, req);

    res.render('public/menu', viewModel, (err, html) => {
      if (err) return next(err);
      menuCache.set(slug, lang, html);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    });
  } catch (err) {
    next(err);
  }
}

router.get('/:slug', renderMenuPage);
// :categoryId используется только клиентским JS как якорь для начального скролла к категории —
// содержимое страницы то же самое, поэтому отдельного разбора параметра тут не требуется.
router.get('/:slug/:categoryId', renderMenuPage);

module.exports = router;
