const express = require('express');

const router = express.Router();
const venueModel = require('../models/venueModel');
const itemModel = require('../models/itemModel');
const itemOptionModel = require('../models/itemOptionModel');
const venuePageViewModel = require('../models/venuePageViewModel');
const venueTableModel = require('../models/venueTableModel');
const menuEventModel = require('../models/menuEventModel');
const reviewModel = require('../models/reviewModel');
const availabilityScheduleModel = require('../models/availabilityScheduleModel');
const eventTracking = require('../services/eventTracking');
const menuCache = require('../services/menuCache');
const availability = require('../services/availability');
const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const { pickLocalized } = require('../utils/localize');
const { SERVICE_NAME } = require('../config/constants');

const LANG_LABELS = { ru: 'RU', uz: 'UZ', en: 'EN' };

const LANG_COOKIE = 'menu_lang';
const VIEW_COOKIE_PREFIX = 'mv_';
const DAY_MS = 24 * 60 * 60 * 1000;
// Промт 2.4: привязка к столу живёт 3 часа — достаточно на один визит (гость не теряет стол,
// переключая категории и язык), но не настолько долго, чтобы завтрашний заказ из дома ушёл
// «со стола 7». Cookie отдельная на заведение: в одном браузере могут быть открыты меню разных
// заведений, и стол из одного не должен подставиться в заказ другому.
const TABLE_COOKIE_PREFIX = 'mt_';
const TABLE_COOKIE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

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

// ?t=<token> из QR-кода на столе -> стол этого заведения. Токен в cookie не кладём (в ней уже
// разрешённый id стола): cookie httpOnly, но токен всё равно секрет самого стола, и таскать его
// по каждому запросу незачем. Невалидный/деактивированный/чужой токен молча игнорируется —
// по промту это «заказ без стола», а не ошибка страницы.
async function resolveTable(req, res, venue) {
  const token = typeof req.query.t === 'string' ? req.query.t.trim() : '';
  if (token) {
    const table = await venueTableModel.findActiveByToken(token, venue.id);
    if (table) {
      res.cookie(`${TABLE_COOKIE_PREFIX}${venue.slug}`, String(table.id), {
        httpOnly: true, sameSite: 'lax', maxAge: TABLE_COOKIE_MAX_AGE_MS,
      });
      return table;
    }
    return null;
  }

  const cookieValue = req.cookies && req.cookies[`${TABLE_COOKIE_PREFIX}${venue.slug}`];
  const tableId = Number(cookieValue);
  if (!Number.isInteger(tableId) || tableId <= 0) return null;
  // Стол мог быть деактивирован или удалён уже после того, как гость отсканировал QR —
  // проверяем на каждом рендере, а не доверяем cookie.
  return venueTableModel.findActiveByIdForVenue(tableId, venue.id);
}

// 'en-GB,en;q=0.9,ru;q=0.8' → ['en', 'ru'] — берём только первичный подтег до дефиса,
// без учёта q-веса (порядок в заголовке уже отражает приоритет браузера).
function parseAcceptLanguage(header) {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => part.split(';')[0].trim().split('-')[0].toLowerCase())
    .filter(Boolean);
}

// Приоритет: явный выбор в query (?lang=) > cookie из прошлого визита > Accept-Language
// (пересечение с enabled_langs заведения) > lang_default. Язык, не включённый у заведения,
// пропускается на каждом шаге — гость молча получает следующий по приоритету, без ошибки.
function resolveLang(req, venue) {
  const enabledLangs = venue.enabled_langs || ['ru', 'uz'];
  const isUsable = (lang) => SUPPORTED_LANGS.includes(lang) && enabledLangs.includes(lang);

  if (isUsable(req.query.lang)) return req.query.lang;

  const cookieLang = req.cookies && req.cookies[LANG_COOKIE];
  if (isUsable(cookieLang)) return cookieLang;

  const acceptLang = parseAcceptLanguage(req.headers['accept-language']).find(isUsable);
  if (acceptLang) return acceptLang;

  return isUsable(venue.lang_default) ? venue.lang_default : enabledLangs[0];
}

// Языки переключателя на странице меню — только включённые у заведения, в фиксированном
// порядке RU/UZ/EN. Пусто, если включён только один (переключатель тогда не рендерится).
function buildLangSwitcherOptions(enabledLangs) {
  return SUPPORTED_LANGS.filter((lang) => enabledLangs.includes(lang)).map((lang) => ({
    code: lang,
    label: LANG_LABELS[lang],
  }));
}

// Промт 3.3, раздел 3. Источник рейтинга ровно один — либо внутренние оценки гостей, либо
// ручное значение суперадмина; складывать их нельзя. Внутренние побеждают, только когда сбор
// включён И оценок набралось не меньше MIN_REVIEWS_FOR_RATING: на двух-трёх оценках среднее
// говорит больше о том, кто первым нажал звезду, чем о заведении.
// Значение попадает в кэшируемый HTML — это допустимо: оно одинаково для всех гостей, а TTL
// кэша 5 минут (см. services/menuCache.js) достаточно, чтобы среднее подтянулось. Специально
// сбрасывать кэш на каждый отзыв не станем: на людном заведении это обнуляло бы кэш постоянно.
function resolveRating(venue, reviewStats) {
  const manual = {
    rating: venue.rating === null || venue.rating === undefined ? null : Number(venue.rating),
    reviewCount: venue.review_count === null || venue.review_count === undefined ? null : Number(venue.review_count),
    ratingSource: 'manual',
  };

  if (!venue.reviews_enabled || !reviewStats) return manual;
  if (reviewStats.count < reviewModel.MIN_REVIEWS_FOR_RATING || reviewStats.average === null) return manual;

  return { rating: reviewStats.average, reviewCount: reviewStats.count, ratingSource: 'internal' };
}

// Общие для всей страницы меню заведения поля (профиль, контакты, wifi, футер).
function buildVenueInfo(venue, lang, reviewStats) {
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
    // Промт 2.4. Признак уровня заведения (одинаковый для всех гостей) — безопасно попадает
    // в кэшируемый HTML. Приём заказов требует и включённого переключателя, и живой привязки
    // к Telegram-группе: без группы заказ некуда отправить, и кнопку показывать незачем.
    ordersAvailable: Boolean(venue.orders_enabled && venue.telegram_chat_id && !venue.telegram_chat_broken),
    // Промт 3.3. Тоже признак уровня заведения — «включён ли сбор отзывов вообще». Показывать
    // ли приглашение ИМЕННО ЭТОМУ гостю (не прошло ли 30 дней с его прошлого отзыва) решает
    // /review/:slug/context: такое в кэшируемый HTML зашивать нельзя.
    reviewsAvailable: Boolean(venue.reviews_enabled),
    // Промт 2.5. Версия меню уходит в service worker и версионирует его HTML-кэш: смена
    // menu_version — это и есть «меню изменилось», старая копия больше не годится.
    menuVersion: venue.menu_version,
    logoUrl: venue.logo_thumb_url || null,
    coverUrl: venue.cover_url || null,
    description: pickLocalized(venue, 'description', lang),
    cuisine: pickLocalized(venue, 'cuisine', lang),
    categoryLabel: pickLocalized(venue, 'category_label', lang),
    district: pickLocalized(venue, 'district', lang),
    ...resolveRating(venue, reviewStats),
  };
}

function buildMetaDescription(venue, tt) {
  const base = tt('publicMenu.metaDescription', { venueName: venue.name });
  if (!venue.address) return base;
  return `${base} ${tt('publicMenu.metaDescriptionAddressSuffix', { address: venue.address })}`;
}

// JSON-LD (schema.org/Restaurant) — только из реально заполненных полей заведения, без
// придуманных данных.
function buildRestaurantJsonLd(venue, baseUrl, lang, effectiveRating, menuPath) {
  const menuUrl = `${baseUrl}${menuPath}`;
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
  const cuisine = pickLocalized(venue, 'cuisine', lang);
  if (cuisine) data.servesCuisine = cuisine;
  // Рейтинг в разметке — тот же самый, что нарисован на странице (промт 3.3: два источника
  // никогда не смешиваются), иначе поисковик увидел бы одно число, а гость — другое.
  if (effectiveRating.rating !== null) {
    data.aggregateRating = { '@type': 'AggregateRating', ratingValue: effectiveRating.rating };
    if (effectiveRating.reviewCount !== null) {
      data.aggregateRating.reviewCount = effectiveRating.reviewCount;
    }
  }
  const sameAs = [venue.instagram_url, venue.telegram_url].filter(Boolean);
  if (sameAs.length) data.sameAs = sameAs;
  return data;
}

// SEO/шеринг-метаданные. Меню теперь всегда одна страница со всеми категориями (категория в URL
// — только якорь для начального скролла на клиенте), так что канонический URL всегда голый URL
// заведения, независимо от того, какой из /menu/:slug или /menu/:slug/:categoryId запросили.
const OG_LOCALES = { ru: 'ru_RU', uz: 'uz_UZ', en: 'en_US' };

// Промт 3.7: «Канонический URL, hreflang, OG и sitemap на кастомном домене указывают на него же,
// а не на основной домен, иначе поисковики склеят страницы неправильно».
//
// Всё держится на одной паре значений: baseUrl (по какому хосту пришли) и menuPath (чем является
// адрес меню на этом хосте). На своём домене меню живёт в КОРНЕ — путь '/', а не '/menu/<slug>';
// оставить там путь сервиса значило бы объявить каноническим адрес, которого на этом домене нет.
// Обе величины вычисляются здесь один раз и расходятся во все теги разом, чтобы canonical и
// hreflang физически не могли разъехаться между собой.
function menuUrlPartsFor(req, venue) {
  if (req.customDomain && req.customDomain.venueId === venue.id) {
    // Основной домен пары, а не тот, по которому пришли: у алиаса с www canonical обязан
    // указывать на основной, иначе две версии страницы конкурируют друг с другом.
    const host = req.customDomain.isPrimary ? req.customDomain.domain : req.get('host');
    return { baseUrl: `${req.protocol}://${host}`, menuPath: '/' };
  }
  return { baseUrl: `${req.protocol}://${req.get('host')}`, menuPath: `/menu/${venue.slug}` };
}

function buildSeoInfo(venue, req, lang, tt, effectiveRating) {
  const { baseUrl, menuPath } = menuUrlPartsFor(req, venue);
  const bareMenuUrl = `${baseUrl}${menuPath}`;
  const enabledLangs = venue.enabled_langs || ['ru', 'uz'];
  return {
    baseUrl,
    canonicalUrl: bareMenuUrl,
    metaDescription: buildMetaDescription(venue, tt),
    ogImageUrl: `${baseUrl}/og/${venue.slug}/image.png?lang=${lang}`,
    ogLocale: OG_LOCALES[lang] || OG_LOCALES.ru,
    hreflangLinks: [
      ...SUPPORTED_LANGS.filter((l) => enabledLangs.includes(l)).map((l) => ({ lang: l, href: `${bareMenuUrl}?lang=${l}` })),
      { lang: 'x-default', href: bareMenuUrl },
    ],
    restaurantJsonLd: buildRestaurantJsonLd(venue, baseUrl, lang, effectiveRating, menuPath),
    serviceName: SERVICE_NAME,
  };
}

// Группы опций позиции для гостя (промт 2.1): локализованные названия, только доступные
// варианты влияют на "от <цены>", подпись-счётчик собирается как "Размер: 3 · Сироп: 2" —
// название группы плюс число вариантов. Именно так, а не «2 размера · 3 добавки» из промта:
// в ru/uz/en у произвольного названия группы нет способа согласовать число ("3 размера",
// но "3 сиропа"), а название + счётчик остаётся грамматичным на всех трёх языках и вдобавок
// говорит гостю, ЧТО именно можно выбрать.
function buildOptionGroupsViewModel(groups, lang) {
  return groups.map((group) => ({
    id: group.id,
    name: pickLocalized(group, 'name', lang),
    selection: group.selection,
    isRequired: group.is_required,
    minSelect: group.min_select,
    maxSelect: group.max_select,
    options: group.options.map((option) => ({
      id: option.id,
      name: pickLocalized(option, 'name', lang),
      priceDelta: Number(option.price_delta),
      isAvailable: option.is_available,
      isDefault: option.is_default,
    })),
  }));
}

function buildItemViewModel(item, lang, tt, optionGroups = []) {
  const description = pickLocalized(item, 'description', lang);
  const composition = pickLocalized(item, 'composition', lang);
  const groups = buildOptionGroupsViewModel(optionGroups, lang);
  const hasSurcharge = groups.some((group) => group.options.some((o) => o.isAvailable && o.priceDelta > 0));
  const optionsSummary = groups
    .map((group) => ({ name: group.name, available: group.options.filter((o) => o.isAvailable).length }))
    .filter((group) => group.available > 0)
    .map((group) => `${group.name}: ${group.available}`)
    .join(' · ');
  // Обязательная группа, в которой не осталось ни одного доступного варианта, делает позицию
  // недоступной целиком (edge case промта): гостю нечего выбрать, а без выбора добавить нельзя —
  // честнее показать "нет в наличии", чем кнопку, которая заведомо ничего не даст.
  const blockedByEmptyRequiredGroup = groups.some(
    (group) => (group.isRequired || group.minSelect > 0) && group.options.every((o) => !o.isAvailable)
  );
  return {
    optionGroups: groups,
    hasOptions: groups.length > 0,
    optionsSummary: optionsSummary || null,
    priceFrom: hasSurcharge,
    id: item.id,
    name: pickLocalized(item, 'name', lang),
    description,
    composition,
    calories: item.calories,
    price: item.price,
    oldPrice: item.old_price,
    discountPercent: item.old_price ? Math.round((1 - item.price / item.old_price) * 100) : null,
    currency: item.currency,
    photoThumbUrl: item.photo_thumb_url,
    photoUrl: item.photo_url,
    tags: item.tags.map((tag) => ({ key: tag, label: tt(`tags.${tag}`) })),
    isAvailable: item.is_available && !blockedByEmptyRequiredGroup,
    // Расширенные данные для карточки блюда (промт 2.2). Аллергены отдаём уже переведённым
    // списком: в карточке они выводятся строкой "содержит: …", а сырые коды гостю не нужны.
    weight: item.weight_value && item.weight_unit
      ? `${Number(item.weight_value).toLocaleString('ru-RU')} ${tt('items.weightUnit_' + item.weight_unit)}`
      : null,
    cookingTimeMinutes: item.cooking_time_minutes || null,
    allergens: (item.allergens || []).map((code) => tt(`allergens.${code}`)),
    spicyLevel: item.spicy_level === null || item.spicy_level === undefined ? null : item.spicy_level,
    isPopular: Boolean(item.is_popular),
  };
}

// Вся видимая часть меню собирается одним запросом (все категории заведения сразу), чтобы лента
// категорий, scroll-spy и поиск по всему меню работали на одной странице без перезагрузки.
// Категории без единой позиции сами не попадают в выборку (INNER JOIN в listByVenueGrouped).
// Промт 2.3. Человекочитаемая подпись расписания: «Пн–Пт 08:00–11:00 · Сб, Вс 09:00–13:00».
// Дни и часы форматирует services/availability.js, строку из них собирает словарь — сервис
// намеренно не знает ни про языки, ни про t().
function buildScheduleLabel(rules, tt) {
  const dayShortNames = [1, 2, 3, 4, 5, 6, 7].map((day) => tt(`schedules.weekdayShort_${day}`));
  const parts = availability.describeRules(rules, dayShortNames);
  if (parts.length === 0) return null;

  return parts
    .map((part) => {
      const period = part.allDay ? tt('schedules.allDay') : tt('schedules.timeRange', { from: part.from, to: part.to });
      return part.allWeek ? period : `${part.days} ${period}`;
    })
    .join(' · ');
}

function buildMenuViewModel(venue, groupedRows, lang, req, optionGroupsByItem = new Map(), reviewStats = null, schedules = []) {
  const tt = (key, params) => t(key, lang, params);

  // Промт 2.3. Доступность считается ЗДЕСЬ, на сервере, в часовом поясе заведения — не на
  // клиенте: страница кэшируется, и клиентский расчёт показал бы завтраки в семь вечера.
  const now = availability.venueNow(venue.timezone);
  const { byCategory: rulesByCategory, byItem: rulesByItem } = availabilityScheduleModel.groupByEntity(schedules);

  const groups = itemModel.groupByCategory(groupedRows).map((group) => {
    const categoryRules = rulesByCategory.get(group.categoryId) || [];
    const categoryName = pickLocalized(
      { name_ru: group.categoryNameRu, name_uz: group.categoryNameUz, name_en: group.categoryNameEn },
      'name',
      lang
    );

    return {
      categoryId: group.categoryId,
      categoryName,
      scheduleHiddenMode: group.scheduleHiddenMode,
      hasSchedule: categoryRules.length > 0,
      scheduleLabel: buildScheduleLabel(categoryRules, tt),
      availableNow: availability.isAvailableNow(categoryRules, now),
      items: group.items.map((item) => {
        // Расписание позиции ПОЛНОСТЬЮ заменяет расписание категории (промт: «расписание
        // позиции имеет приоритет»), а не дополняет его: иначе «завтрак кроме понедельника»
        // было бы невыразимо.
        const ownRules = rulesByItem.get(item.id) || [];
        const effectiveRules = ownRules.length > 0 ? ownRules : categoryRules;

        return {
          ...buildItemViewModel(item, lang, tt, optionGroupsByItem.get(item.id) || []),
          // Нужны карточке блюда: лента "ещё из этой категории" собирается на клиенте.
          categoryId: group.categoryId,
          categoryName,
          scheduleHiddenMode: group.scheduleHiddenMode,
          // isAvailable (ручной рубильник «нет в наличии») и availableNow (расписание) — разные
          // вещи и подписываются гостю по-разному: «нет в наличии» против «доступно с 8:00».
          availableNow: availability.isAvailableNow(effectiveRules, now),
          scheduleLabel: effectiveRules.length > 0 ? buildScheduleLabel(effectiveRules, tt) : null,
        };
      }),
    };
  });

  // Теги для панели фильтров — только те, что реально встречаются хотя бы у одной позиции
  // этого заведения ("new" — маркетинговый бейдж, а не признак блюда, в фильтр не идёт).
  const tagSet = new Set();
  groups.forEach((group) => group.items.forEach((item) => item.tags.forEach((tag) => {
    if (tag.key !== 'new') tagSet.add(tag.key);
  })));
  const availableTags = Array.from(tagSet).map((key) => ({ key, label: tt(`tags.${key}`) }));

  // allItems — ВСЕ позиции, включая скрытые расписанием: по нему строится и прямая ссылка на
  // блюдо (?item=<id>), и данные карточек на клиенте. Ссылку на утреннее блюдо, открытую
  // вечером, честнее встретить карточкой с подписью «доступно с 8:00», чем «позиции больше нет».
  const allItems = groups.reduce((acc, group) => acc.concat(group.items), []);
  const venueInfo = buildVenueInfo(venue, lang, reviewStats);

  return {
    ...applyScheduleVisibility(groups, tt),
    allItems,
    availableTags,
    lang,
    langSwitcherOptions: buildLangSwitcherOptions(venue.enabled_langs || ['ru', 'uz']),
    t: tt,
    // Ближайшая граница интервала — потолок жизни страницы в кэше (см. menuCache.set).
    // null означает «расписаний нет», и тогда TTL остаётся обычным.
    cacheMaxAgeMs: (() => {
      const seconds = availability.secondsUntilChange(schedules, now);
      return seconds === null ? null : seconds * 1000;
    })(),
    // Для сообщения «сейчас меню недоступно, откроем в 8:00» (edge case промта). Берётся
    // ближайшее открытие ЛЮБОГО расписания заведения — гостю важно, когда снова будет что
    // заказать, а не когда откроется конкретная категория.
    nextOpeningTime: (() => {
      const seconds = availability.nextOpeningSeconds(schedules, now);
      return seconds === null ? null : availability.secondsToTime(seconds);
    })(),
    ...venueInfo,
    ...buildSeoInfo(venue, req, lang, tt, venueInfo),
  };
}

// Промт 2.3, раздел 3. Три режима того, что делать с недоступным по времени. Режим берётся
// у категории и применяется ко всем её позициям, включая те, у которых своё расписание.
function applyScheduleVisibility(groups, tt) {
  const visibleGroups = [];
  // Режим 'section' — одна общая секция «Доступно в другое время» внизу страницы, а не по
  // секции на категорию: иначе низ страницы превратился бы в копию всего меню.
  const otherTimeItems = [];
  let totalItems = 0;
  let unavailableItems = 0;

  groups.forEach((group) => {
    const availableItems = group.items.filter((item) => item.availableNow);
    const hiddenItems = group.items.filter((item) => !item.availableNow);
    totalItems += group.items.length;
    unavailableItems += hiddenItems.length;

    if (group.scheduleHiddenMode === 'dim') {
      visibleGroups.push(group);
      return;
    }

    if (group.scheduleHiddenMode === 'section') {
      hiddenItems.forEach((item) => otherTimeItems.push(item));
    }

    // hide и section: пустая категория не рендерится вовсе — ни заголовка, ни чипса
    // (edge case промта). Для 'section' её позиции при этом уже уехали вниз.
    if (availableItems.length === 0) return;
    visibleGroups.push({ ...group, items: availableItems });
  });

  return {
    groups: visibleGroups,
    otherTimeItems,
    otherTimeHeading: tt('schedules.otherTimeHeading'),
    // Меню целиком вне расписания (гость зашёл ночью). Показывать пустую страницу нельзя —
    // сообщение с ближайшим временем открытия и контактами собирается в renderMenuPage.
    allItemsOutOfSchedule: totalItems > 0 && unavailableItems === totalItems,
  };
}

// venues.status === 'draft' — заведение существует, но ещё не публиковалось, ссылок на его
// страницу нигде нет: с точки зрения гостя её как будто не существует, тот же ответ, что и для
// несуществующего slug (см. промт 1.3, раздел "Поведение публичной страницы").
function renderNotFound(req, res) {
  const lang = SUPPORTED_LANGS.includes(req.query.lang) ? req.query.lang : DEFAULT_LANG;
  // Промт 2.5: service worker не должен положить эту страницу в кэш меню — иначе гость,
  // поставивший приложение, увидел бы «не найдено» и после того, как заведение вернулось.
  res.set('X-Menu-Cacheable', '0');
  return res.status(404).render('public/menu-not-found', { lang, t: (key, params) => t(key, lang, params) });
}

// Общая для is_active=false / suspended / archived страница-заглушка — QR-коды уже напечатаны
// и висят на столах, ссылка не должна умирать: код ответа разный (200 для is_active=false и
// suspended, 410 Gone для archived — ясный сигнал поисковику, что страница не вернётся), но
// вёрстка и текст одинаковые, без единого намёка на причину (гость не должен знать про неоплату).
function renderUnavailable(req, res, venue, lang, statusCode) {
  // Промт 2.5, edge case: «гость установил PWA, заведение перешло в suspended — показывается
  // страница-заглушка, а не старое кэшированное меню». Network-first уже отдаёт свежий ответ,
  // но заглушка возвращается с кодом 200 и осела бы в кэше как меню — этот заголовок ей мешает.
  res.set('X-Menu-Cacheable', '0');
  return res.status(statusCode).render('public/menu-unavailable', {
    venueName: venue.name,
    phone: venue.phone,
    address: venue.address,
    address2gisUrl: venue.address_2gis_url,
    instagramUrl: venue.instagram_url,
    telegramUrl: venue.telegram_url,
    logoUrl: venue.logo_thumb_url || null,
    lang,
    t: (key, params) => t(key, lang, params),
  });
}

// Промт 1.6, пункт чеклиста "Проверить меню" — единственный способ увидеть публичную страницу
// черновика: собственный владелец, залогиненный именно в это заведение (venue_id из сессии,
// не просто "любой venue_admin" — чужой draft по-прежнему не должен быть виден). Гость
// по-прежнему получает 404 для draft — ни статус, ни содержимое чужого черновика не палятся.
function isOwnerPreview(req, venue) {
  return venue.status === 'draft'
    && Boolean(req.session && req.session.admin)
    && req.session.admin.role === 'venue_admin'
    && req.session.admin.venueId === venue.id;
}

async function buildFullViewModel(venue, lang, req) {
  const [rows, optionGroupsByItem, reviewStats, schedules] = await Promise.all([
    itemModel.listByVenueGrouped(venue.id),
    itemOptionModel.listGroupsByItemForVenue(venue.id),
    // Считаем, только если сбор включён: у заведения без отзывов это лишний запрос на каждый
    // промах кэша, а результат всё равно не будет использован (см. resolveRating).
    venue.reviews_enabled ? reviewModel.ratingStats(venue.id) : Promise.resolve(null),
    // Промт 2.3: все расписания заведения одним запросом — и категорий, и позиций.
    availabilityScheduleModel.listByVenue(venue.id),
  ]);
  return buildMenuViewModel(venue, rows, lang, req, optionGroupsByItem, reviewStats, schedules);
}

// Мета-теги и начальное состояние для прямой ссылки на блюдо. Позиции может уже не быть
// (удалили/сняли с продажи, а ссылку кто-то сохранил) — тогда карточка всё равно открывается,
// но с пометкой "этой позиции больше нет в меню": 404 на живом меню сбивал бы с толку сильнее.
function toAbsoluteUrl(url, baseUrl) {
  return /^https?:\/\//i.test(url) ? url : `${baseUrl}${url}`;
}

function itemLinkExtras(viewModel, requestedItemId, req, venue) {
  if (!requestedItemId) {
    return { initialItemId: null, initialItemMissing: false };
  }

  const item = viewModel.allItems.find((candidate) => candidate.id === requestedItemId) || null;
  if (!item) {
    return { initialItemId: requestedItemId, initialItemMissing: true };
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const itemUrl = `${baseUrl}/menu/${venue.slug}?item=${item.id}`;
  const description = item.description
    || [item.composition, item.weight].filter(Boolean).join(' · ')
    || viewModel.metaDescription;

  return {
    initialItemId: item.id,
    initialItemMissing: false,
    pageTitle: `${item.name} — ${venue.name}`,
    metaDescription: description,
    canonicalUrl: itemUrl,
    ogUrl: itemUrl,
    // Фото позиции как превью ссылки; если фото нет — общая картинка заведения, которую
    // и так генерирует /og/:slug/image.png. Часть фото залита к нам (относительный путь,
    // нужен домен), часть приходит абсолютной ссылкой на внешнее хранилище — её не трогаем.
    ogImageUrl: item.photoUrl ? toAbsoluteUrl(item.photoUrl, baseUrl) : viewModel.ogImageUrl,
  };
}

async function renderMenuPage(req, res, next) {
  try {
    const { slug } = req.params;

    const venue = await venueModel.findPublicBySlug(slug);
    if (!venue) {
      return renderNotFound(req, res);
    }

    const preview = isOwnerPreview(req, venue);
    if (venue.status === 'draft' && !preview) {
      return renderNotFound(req, res);
    }

    const lang = resolveLang(req, venue);
    if (SUPPORTED_LANGS.includes(req.query.lang)) {
      res.cookie(LANG_COOKIE, lang, { httpOnly: false, sameSite: 'lax' });
    }

    // is_active=false — ручной рубильник суперадмина, действует поверх любого статуса
    // (архивное заведение с is_active=false всё равно отдаёт 200, а не 410 — это тот же самый
    // "временно недоступно", а не "окончательно закрыто"). Предпросмотр черновика владельцем —
    // единственное исключение: draft по определению is_active=false (см. leadApproval.js),
    // иначе владелец никогда не увидел бы собственное меню до публикации.
    if (!preview) {
      if (!venue.is_active) {
        return renderUnavailable(req, res, venue, lang, 200);
      }
      if (venue.status === 'suspended') {
        return renderUnavailable(req, res, venue, lang, 200);
      }
      if (venue.status === 'archived') {
        return renderUnavailable(req, res, venue, lang, 410);
      }
    }

    // Промт 2.4. Вызывается ТОЛЬКО ради побочного эффекта — поставить cookie стола, если гость
    // пришёл по QR со стола (?t=<token>). Номер стола намеренно НЕ попадает в отрисованный HTML:
    // страница кэшируется по slug+lang, и вкладка гостя за столом 5 иначе раздавала бы «стол 5»
    // всем остальным. Актуальный стол экран заказа спрашивает отдельно (GET /order/:slug/context),
    // а при самой отправке заказа сервер всё равно перерезолвит его сам из этой же cookie.
    await resolveTable(req, res, venue);

    // Предпросмотр не считается просмотром гостя и не читает/не пишет общий кэш меню —
    // кэш ключуется по slug+lang и обслуживает реальных посетителей, смешивать с ним
    // черновик (который вот-вот может стать другим содержимым) не стоит.
    if (!preview) {
      // Промт 3.2: page_view пишется на КАЖДЫЙ показ страницы, а не только на "уникальный визит
      // за день", как venue_page_views ниже — иначе разбивка по часам суток/дням недели в
      // аналитике потеряла бы весь сигнал повторных заходов одного гостя за день. Это отдельная,
      // более подробная метрика поверх старой, а не замена ей (см. README, промт 3.2).
      menuEventModel.insertOne(eventTracking.buildPageViewRow(venue.id, req, lang)).catch((err) => {
        console.error('Не удалось записать событие page_view', err);
      });

      if (shouldCountView(req, slug)) {
        markViewCounted(res, slug);
        venuePageViewModel.recordView(venue.id).catch((err) => {
          console.error('Не удалось записать просмотр меню', err);
        });
      }
    }

    // ?item=<id> — прямая ссылка на карточку блюда (промт 2.2). Страница с таким параметром
    // отдаёт мета-теги конкретной позиции, поэтому мимо общего кэша: он ключуется по slug+lang
    // и на всех ссылках вернул бы одни и те же теги заведения.
    const requestedItemId = Number(req.query.item) || null;

    if (preview) {
      const viewModel = await buildFullViewModel(venue, lang, req);
      return res.render('public/menu', {
        ...viewModel, isPreview: true,
        ...itemLinkExtras(viewModel, requestedItemId, req, venue),
      });
    }

    // Промт 3.7: ключ кэша включает хост — одно и то же меню на своём домене и на адресе
    // сервиса отдаёт разные canonical/hreflang/og:url (см. menuUrlPartsFor выше), и общий
    // ключ раздал бы одну из версий на обоих адресах.
    const cacheHost = req.get('host') || '';

    if (!requestedItemId) {
      const cached = menuCache.get(cacheHost, slug, lang);
      if (cached) {
        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(cached);
      }
    }

    const viewModel = await buildFullViewModel(venue, lang, req);
    const extras = itemLinkExtras(viewModel, requestedItemId, req, venue);

    if (requestedItemId) {
      return res.render('public/menu', { ...viewModel, isPreview: false, ...extras });
    }

    res.render('public/menu', { ...viewModel, isPreview: false, ...extras }, (err, html) => {
      if (err) return next(err);
      // Промт 2.3: страница не должна пережить ближайшую границу интервала расписания —
      // иначе кэш покажет вчерашние завтраки. Без расписаний cacheMaxAgeMs === null и TTL
      // остаётся прежним (см. services/menuCache.js).
      menuCache.set(venue.id, cacheHost, slug, lang, html, viewModel.cacheMaxAgeMs);
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
