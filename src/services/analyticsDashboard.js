const itemModel = require('../models/itemModel');
const menuStatsModel = require('../models/menuStatsModel');
const { pickLocalized } = require('../utils/localize');
const {
  todayUTC, addDaysUTC, formatDateOnly, parseDateOnly, isValidDateOnly, diffDaysUTC,
} = require('../utils/dateOnly');

const { OWNER_EXCLUDED_PREFIX } = menuStatsModel;

const PERIOD_PRESETS = { 7: 7, 30: 30 };
const MAX_CUSTOM_DAYS = 180; // тот же горизонт, что и retention сырых событий — дальше агрегатов всё равно нет смысла спрашивать
const MIN_EVENTS_FOR_CHARTS = 20; // промт 3.2: "мало данных — не рисовать графики"
const TOP_LIST_LIMIT = 10;

const ALL_METRICS = [
  'page_view', 'page_view_hour', 'item_view', 'item_add',
  'search', 'search_empty', 'lang', 'device', 'source', 'order_sent_table',
];

// Промт 3.2: период 7/30 дней или произвольный. Невалидный/отсутствующий ?period трактуется как
// 7 — тот же принцип "не подходящий параметр тихо откатывается к разумному дефолту", что и у
// resolveLang в publicMenu.js, а не 400 гостю (тут это владелец, но принцип тот же).
function resolvePeriod(query) {
  const today = todayUTC();

  if (query.period === 'custom' && isValidDateOnly(query.from) && isValidDateOnly(query.to)) {
    let from = parseDateOnly(query.from);
    let to = parseDateOnly(query.to);
    if (to.getTime() > today.getTime()) to = today; // будущее не показываем — данных там нет и не будет
    if (from.getTime() > to.getTime()) from = to;
    if (diffDaysUTC(to, from) + 1 > MAX_CUSTOM_DAYS) from = addDaysUTC(to, -(MAX_CUSTOM_DAYS - 1));
    return { from, to, days: diffDaysUTC(to, from) + 1, preset: 'custom' };
  }

  const days = PERIOD_PRESETS[query.period] || PERIOD_PRESETS[7];
  const to = today;
  const from = addDaysUTC(to, -(days - 1));
  return { from, to, days, preset: String(days) };
}

// Тот же по длине период непосредственно перед текущим — для "сравнение с предыдущим периодом
// в процентах" (промт 3.2, блок "Просмотры меню").
function previousPeriod(period) {
  const to = addDaysUTC(period.from, -1);
  const from = addDaysUTC(to, -(period.days - 1));
  return { from, to, days: period.days };
}

function computeTrendPercent(current, previous) {
  if (previous <= 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

// menu_stats_daily хранит owner_excluded:* отдельным неймспейсом метрик, и только за те дни,
// когда владелец реально что-то смотрел (см. analyticsAggregation.js) — за остальные дни строки
// с этим префиксом попросту нет, что означает "совпадает с обычным значением". Поэтому при
// excludeOwner=true каждая строка "как есть" сначала кладётся в карту, а затем избирательно
// перезаписывается своим owner_excluded-двойником там, где он есть — отсутствие двойника само
// по себе уже правильный ответ (обычное значение и есть исключающее).
async function fetchMergedRows(venueId, excludeOwner, from, to) {
  const fromDate = formatDateOnly(from);
  const toDate = formatDateOnly(to);
  const plainRows = await menuStatsModel.listForPeriod(venueId, ALL_METRICS, fromDate, toDate);

  const merged = new Map();
  plainRows.forEach((row) => {
    merged.set(`${row.stat_on}|${row.metric}|${row.dimension}`, Number(row.value));
  });

  if (excludeOwner) {
    const excludedMetrics = ALL_METRICS.map((m) => `${OWNER_EXCLUDED_PREFIX}${m}`);
    const excludedRows = await menuStatsModel.listForPeriod(venueId, excludedMetrics, fromDate, toDate);
    excludedRows.forEach((row) => {
      const plainMetric = row.metric.slice(OWNER_EXCLUDED_PREFIX.length);
      merged.set(`${row.stat_on}|${plainMetric}|${row.dimension}`, Number(row.value));
    });
  }

  return merged; // ключ "stat_on|metric|dimension" -> число
}

// stat_on приходит из БД как 'YYYY-MM-DD' (см. config/db.js — сырые строки для date-колонок).
function rowsForMetric(merged, metric) {
  const rows = [];
  merged.forEach((value, key) => {
    const [statOn, rowMetric, dimension] = key.split('|');
    if (rowMetric === metric) rows.push({ statOn, dimension, value });
  });
  return rows;
}

function sumByDimension(rows, limit) {
  const totals = new Map();
  rows.forEach((r) => totals.set(r.dimension, (totals.get(r.dimension) || 0) + r.value));
  const sorted = Array.from(totals.entries())
    .map(([dimension, value]) => ({ dimension, value }))
    .sort((a, b) => b.value - a.value);
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
}

function eachDate(from, to) {
  const dates = [];
  let cursor = from;
  while (cursor.getTime() <= to.getTime()) {
    dates.push(cursor);
    cursor = addDaysUTC(cursor, 1);
  }
  return dates;
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // getUTCDay(): 0=вс..6=сб

function buildDailyPageViews(merged, period, tt) {
  const rows = rowsForMetric(merged, 'page_view').filter((r) => r.dimension === '');
  const byDate = new Map(rows.map((r) => [r.statOn, r.value]));
  const days = eachDate(period.from, period.to).map((date) => ({
    date: formatDateOnly(date),
    label: date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
    count: byDate.get(formatDateOnly(date)) || 0,
  }));
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const max = Math.max(1, ...days.map((d) => d.count));
  return {
    days: days.map((d) => ({ ...d, heightPercent: Math.max(2, Math.round((d.count / max) * 100)) })),
    total,
  };
}

function buildHourlyPeak(merged, period) {
  const rows = rowsForMetric(merged, 'page_view_hour');
  const byHour = new Array(24).fill(0);
  rows.forEach((r) => { byHour[Number(r.dimension)] += r.value; });
  // "усреднённая за период" (промт 3.2) — сумма по часу делится на число дней периода, а не
  // только на дни, где что-то было: иначе один случайный визит в 3 ночи выглядел бы как
  // "стабильно приходят ночью", а не как разовый выброс.
  const averaged = byHour.map((sum) => sum / period.days);
  const max = Math.max(0.0001, ...averaged);
  return averaged.map((value, hour) => ({
    hour,
    value: Math.round(value * 10) / 10,
    heightPercent: Math.max(2, Math.round((value / max) * 100)),
  }));
}

function buildDayOfWeek(merged, tt) {
  const rows = rowsForMetric(merged, 'page_view').filter((r) => r.dimension === '');
  const byDow = new Array(7).fill(0);
  rows.forEach((r) => {
    const dow = parseDateOnly(r.statOn).getUTCDay();
    byDow[dow] += r.value;
  });
  // Неделя отображается с понедельника (принято в ru/uz), хотя getUTCDay() считает от воскресенья.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const max = Math.max(1, ...byDow);
  return order.map((dow) => ({
    label: tt(`analytics.dow.${WEEKDAY_KEYS[dow]}`),
    value: byDow[dow],
    heightPercent: Math.max(2, Math.round((byDow[dow] / max) * 100)),
  }));
}

// Позиции заведения (без демо — те не в счёт нигде в аналитике, как и в чеклисте онбординга)
// с уже посчитанными item_view/item_add за период — общая заготовка для "топ просматриваемых",
// "топ добавляемых", "смотрят, но не берут" и "не просматривали ни разу".
async function buildItemStats(venueId, merged, lang, tt) {
  const viewRows = rowsForMetric(merged, 'item_view');
  const addRows = rowsForMetric(merged, 'item_add');
  const viewsByItem = new Map();
  viewRows.forEach((r) => viewsByItem.set(r.dimension, (viewsByItem.get(r.dimension) || 0) + r.value));
  const addsByItem = new Map();
  addRows.forEach((r) => addsByItem.set(r.dimension, (addsByItem.get(r.dimension) || 0) + r.value));

  const allItems = (await itemModel.listByVenueGrouped(venueId)).filter((item) => !item.is_demo);
  const itemName = new Map(allItems.map((item) => [String(item.id), pickLocalized(item, 'name', lang)]));

  const topViewed = Array.from(viewsByItem.entries())
    .map(([itemId, views]) => ({ itemId, name: itemName.get(itemId) || `#${itemId}`, views, adds: addsByItem.get(itemId) || 0 }))
    .filter((row) => itemName.has(row.itemId)) // позиция могла быть удалена после события — не показываем в топе
    .sort((a, b) => b.views - a.views)
    .slice(0, TOP_LIST_LIMIT);

  const topAdded = Array.from(addsByItem.entries())
    .map(([itemId, adds]) => ({ itemId, name: itemName.get(itemId) || `#${itemId}`, adds }))
    .filter((row) => itemName.has(row.itemId))
    .sort((a, b) => b.adds - a.adds)
    .slice(0, TOP_LIST_LIMIT);

  // "Смотрят, но не берут" (промт 3.2) — заметный просмотр (иначе 1 просмотр без добавления
  // ничего не говорит) при низкой доле добавивших. Пороги: минимум 3 просмотра за период,
  // доля добавивших не выше 20% — оба числа эвристика, а не что-то из промта дословно.
  const MIN_VIEWS_FOR_SIGNAL = 3;
  const MAX_ADD_RATIO = 0.2;
  const viewedNotAdded = Array.from(viewsByItem.entries())
    .map(([itemId, views]) => ({ itemId, name: itemName.get(itemId), views, adds: addsByItem.get(itemId) || 0 }))
    .filter((row) => row.name && row.views >= MIN_VIEWS_FOR_SIGNAL && row.adds / row.views <= MAX_ADD_RATIO)
    .sort((a, b) => b.views - a.views)
    .slice(0, TOP_LIST_LIMIT);

  const neverViewed = allItems
    .filter((item) => !viewsByItem.has(String(item.id)))
    .map((item) => ({ itemId: String(item.id), name: pickLocalized(item, 'name', lang) }))
    .slice(0, TOP_LIST_LIMIT);

  return { topViewed, topAdded, viewedNotAdded, neverViewed };
}

function buildBreakdown(merged, metric, allowedKeys, labelFn) {
  const rows = sumByDimension(rowsForMetric(merged, metric));
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const known = allowedKeys
    .map((key) => ({ key, label: labelFn(key), value: (rows.find((r) => r.dimension === key) || { value: 0 }).value }))
    .filter((r) => r.value > 0);
  return { rows: known, total };
}

async function buildDashboard(venue, query, lang, tt) {
  const period = resolvePeriod(query);
  const excludeOwner = venue.exclude_owner_views;

  const [merged, prevMerged] = await Promise.all([
    fetchMergedRows(venue.id, excludeOwner, period.from, period.to),
    fetchMergedRows(venue.id, excludeOwner, previousPeriod(period).from, previousPeriod(period).to),
  ]);

  const dailyPageViews = buildDailyPageViews(merged, period, tt);
  const prevTotal = rowsForMetric(prevMerged, 'page_view').filter((r) => r.dimension === '').reduce((s, r) => s + r.value, 0);

  // Порог "мало данных" (промт 3.2, edge case) — по суммарным просмотрам за период: меньше 20 и
  // графики/списки не показываются вовсе, только это сообщение. Ложные выводы из трёх просмотров
  // хуже, чем отсутствие графика.
  const hasEnoughData = dailyPageViews.total >= MIN_EVENTS_FOR_CHARTS;

  if (!hasEnoughData) {
    return { period, hasEnoughData, totalViews: dailyPageViews.total };
  }

  const [itemStats, searchTop, searchEmptyTop] = await Promise.all([
    buildItemStats(venue.id, merged, lang, tt),
    sumByDimension(rowsForMetric(merged, 'search'), TOP_LIST_LIMIT),
    sumByDimension(rowsForMetric(merged, 'search_empty'), TOP_LIST_LIMIT),
  ]);

  return {
    period,
    hasEnoughData,
    totalViews: dailyPageViews.total,
    dailyPageViews,
    trendPercent: computeTrendPercent(dailyPageViews.total, prevTotal),
    hourlyPeak: buildHourlyPeak(merged, period),
    dayOfWeek: buildDayOfWeek(merged, tt),
    ...itemStats,
    searchTop,
    searchEmptyTop,
    langBreakdown: buildBreakdown(merged, 'lang', ['ru', 'uz', 'en'], (k) => tt(`analytics.langName.${k}`)),
    deviceBreakdown: buildBreakdown(merged, 'device', ['mobile', 'tablet', 'desktop'], (k) => tt(`analytics.device.${k}`)),
    sourceBreakdown: buildBreakdown(merged, 'source', ['qr', 'link', 'social', 'direct'], (k) => tt(`analytics.source.${k}`)),
    tableTop: sumByDimension(rowsForMetric(merged, 'order_sent_table'), TOP_LIST_LIMIT),
  };
}

// Промт 3.2, раздел 4 "Экспорт и сводки" — данные для еженедельного сообщения в Telegram
// (bot/worker/scheduler.js + bot/templates/notifications.js). Не переиспользует buildDashboard
// целиком: там считается гораздо больше (часы пик, дни недели, "не просматривали", разбивки
// по устройствам/языкам) — сводке в мессенджер нужны только просмотры+тренд и два топ-3.
async function buildWeeklySummary(venue, weekStart, weekEnd) {
  const excludeOwner = venue.exclude_owner_views;
  const prevStart = addDaysUTC(weekStart, -7);
  const prevEnd = addDaysUTC(weekEnd, -7);

  const [merged, prevMerged] = await Promise.all([
    fetchMergedRows(venue.id, excludeOwner, weekStart, weekEnd),
    fetchMergedRows(venue.id, excludeOwner, prevStart, prevEnd),
  ]);

  const totalViews = rowsForMetric(merged, 'page_view').filter((r) => r.dimension === '').reduce((s, r) => s + r.value, 0);
  const prevTotal = rowsForMetric(prevMerged, 'page_view').filter((r) => r.dimension === '').reduce((s, r) => s + r.value, 0);

  const topItemRows = sumByDimension(rowsForMetric(merged, 'item_view'), 3);
  const items = await itemModel.listByVenueGrouped(venue.id);
  const nameById = new Map(items.map((item) => [String(item.id), pickLocalized(item, 'name', venue.lang_default || 'ru')]));
  const topDishes = topItemRows.map((r) => nameById.get(r.dimension)).filter(Boolean);

  const topEmptySearches = sumByDimension(rowsForMetric(merged, 'search_empty'), 3).map((r) => r.dimension);

  return {
    totalViews,
    trendPercent: computeTrendPercent(totalViews, prevTotal),
    topDishes,
    topEmptySearches,
  };
}

module.exports = { buildDashboard, resolvePeriod, buildWeeklySummary };
