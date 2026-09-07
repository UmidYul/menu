const menuEventModel = require('../models/menuEventModel');
const menuStatsModel = require('../models/menuStatsModel');
const adminSessionHashModel = require('../models/adminSessionHashModel');
const { todayUTC, addDaysUTC, formatDateOnly } = require('../utils/dateOnly');

// Префикс метрик "без просмотров владельца" (промт 3.2, переключатель на странице аналитики,
// см. также src/services/analyticsDashboard.js — читающая сторона того же префикса). menu_
// stats_daily хранит только счётчики, session_hash к этому моменту уже потерян — поэтому вариант
// "без владельца" считается отдельным проходом по тем же сырым событиям И ТОЛЬКО тогда, когда за
// день вообще было хоть одно совпадение admin_session_hashes (см. computeRowsForVenueDay): в
// подавляющем большинстве дней владелец вообще не открывал своё меню, тогда "с владельцем" и
// "без" совпадают, и считать/хранить второй набор строк незачем.
const { OWNER_EXCLUDED_PREFIX } = menuStatsModel;

const RETENTION_DAYS = 180;
const DELETE_BATCH_SIZE = 5000;

// Промт 3.2, раздел 2 "Агрегация". Список метрик, которые считаются на каждый день для каждого
// заведения — dimension пустой у "total"-метрик, наполненный у "по группам" метрик. lang/device/
// source считаются от page_view (см. комментарий в buildEventRow/eventTracking.js: это самое
// частое событие, есть у каждого визита, и volume-weighted разбивка по нему честнее, чем по
// более редким и не всегда присутствующим событиям типа lang_switch).
// order_sent_table пока всегда даст пустой список (order_sent никто не отправляет — заказы и
// столы появятся в промтах 2.4/3.4) — это ожидаемо, метрика заведена заранее.
const GROUPED_METRICS = [
  { metric: 'item_view', eventType: 'item_view', column: 'item_id' },
  { metric: 'item_add', eventType: 'item_add', column: 'item_id' },
  { metric: 'search', eventType: 'search', column: 'query' },
  { metric: 'search_empty', eventType: 'search_empty', column: 'query' },
  { metric: 'lang', eventType: 'page_view', column: 'lang' },
  { metric: 'device', eventType: 'page_view', column: 'device' },
  { metric: 'source', eventType: 'page_view', column: 'source' },
  { metric: 'order_sent_table', eventType: 'order_sent', column: 'table_id' },
];

// Один проход подсчёта всех метрик за день — с исключением набора session_hash (пустой список
// означает "без исключений", тогда metricPrefix пустой и пишутся обычные имена метрик).
async function computeMetricRows(venueId, dayStart, dayEnd, statOn, excludeHashes, metricPrefix) {
  const rows = [];

  const pageViewTotal = await menuEventModel.countTotal(venueId, 'page_view', dayStart, dayEnd, excludeHashes);
  rows.push({ venue_id: venueId, stat_on: statOn, metric: `${metricPrefix}page_view`, dimension: '', value: pageViewTotal });

  const hourly = await menuEventModel.countGroupedByHour(venueId, 'page_view', dayStart, dayEnd, excludeHashes);
  hourly.forEach((r) => rows.push({ venue_id: venueId, stat_on: statOn, metric: `${metricPrefix}page_view_hour`, dimension: r.dimension, value: r.value }));

  for (const spec of GROUPED_METRICS) {
    // eslint-disable-next-line no-await-in-loop -- умышленно последовательно: пара запросов на
    // метрику на заведение в час (либо на владельца, если у него сегодня были просмотры),
    // распараллеливание не окупает сложность.
    const grouped = await menuEventModel.countGroupedByColumn(venueId, spec.eventType, spec.column, dayStart, dayEnd, excludeHashes);
    grouped.forEach((r) => rows.push({ venue_id: venueId, stat_on: statOn, metric: `${metricPrefix}${spec.metric}`, dimension: r.dimension, value: r.value }));
  }

  return rows;
}

// Один день одного заведения -> строки menu_stats_daily, обычные плюс (если было чем) owner_excluded.
async function computeRowsForVenueDay(venueId, dayStart) {
  const dayEnd = addDaysUTC(dayStart, 1);
  const statOn = formatDateOnly(dayStart);

  const plainRows = await computeMetricRows(venueId, dayStart, dayEnd, statOn, null, '');
  const rows = [...plainRows];

  const ownerHashes = await adminSessionHashModel.listHashesForVenue(venueId, statOn, statOn);
  if (ownerHashes.length > 0) {
    const excludedRows = await computeMetricRows(venueId, dayStart, dayEnd, statOn, ownerHashes, OWNER_EXCLUDED_PREFIX);
    // Ключи сравниваем по НЕпрефиксованному имени метрики (как оно записано в plainRow) — в
    // excludedRows метрика уже с префиксом owner_excluded:, срезаем его обратно для сравнения.
    const excludedKeys = new Set(excludedRows.map((r) => `${r.metric.slice(OWNER_EXCLUDED_PREFIX.length)}:${r.dimension}`));
    // GROUP BY не эмитит строку для измерения, у которого не осталось ни одного события после
    // исключения владельца (в отличие от countTotal, который всегда возвращает строку, пусть и
    // с value=0) — то есть "измерение держалось только на просмотрах владельца" на выходе
    // countGroupedByColumn/Hour неотличимо от "это измерение никогда не считалось". Дописываем
    // явный нулевой owner_excluded для каждой пары (metric, dimension), которая была в обычном
    // подсчёте, но пропала в исключающем — иначе чтение дашборда (см. adminAnalytics.js) при
    // отсутствии owner_excluded-строки ошибочно подставило бы полное, неисключённое значение.
    plainRows.forEach((plainRow) => {
      const key = `${plainRow.metric}:${plainRow.dimension}`;
      if (!excludedKeys.has(key)) {
        excludedRows.push({
          venue_id: venueId, stat_on: statOn,
          metric: `${OWNER_EXCLUDED_PREFIX}${plainRow.metric}`, dimension: plainRow.dimension, value: 0,
        });
      }
    });
    rows.push(...excludedRows);
  }

  return rows;
}

// Промт 3.2: "агрегирует вчерашние и сегодняшние события" — сегодня входит, потому что тик
// часовой, а не суточный: без пересчёта "сегодня" на каждый тик дашборд весь день показывал бы
// вчерашние цифры для текущего дня. Идемпотентно — see upsertBatch (ON CONFLICT DO UPDATE).
async function aggregateDailyStats() {
  const today = todayUTC();
  const yesterday = addDaysUTC(today, -1);

  for (const dayStart of [yesterday, today]) {
    const dayEnd = addDaysUTC(dayStart, 1);
    // eslint-disable-next-line no-await-in-loop
    const venueIds = await menuEventModel.listVenuesWithEventsBetween(dayStart, dayEnd);
    for (const venueId of venueIds) {
      // eslint-disable-next-line no-await-in-loop -- заведений на инсталляции немного,
      // последовательный обход проще в отладке, чем Promise.all с общим пулом соединений.
      const rows = await computeRowsForVenueDay(venueId, dayStart);
      // eslint-disable-next-line no-await-in-loop
      await menuStatsModel.upsertBatch(rows);
    }
  }
}

// Пачками по 5000 строк, а не одним DELETE (промт 3.2) — цикл идёт, пока запрос не удалит
// меньше полной пачки (значит, старых строк больше не осталось).
async function cleanupOldEvents() {
  const cutoff = addDaysUTC(todayUTC(), -RETENTION_DAYS);
  let deleted;
  do {
    // eslint-disable-next-line no-await-in-loop -- последовательные пачки нужны для того самого
    // "не одна долгая транзакция" — параллельные DELETE тут не имели бы смысла.
    deleted = await menuEventModel.deleteOlderThanBatch(cutoff, DELETE_BATCH_SIZE);
  } while (deleted === DELETE_BATCH_SIZE);
}

async function runHourlyTick() {
  await aggregateDailyStats();
  await cleanupOldEvents();
}

module.exports = { aggregateDailyStats, cleanupOldEvents, runHourlyTick, computeRowsForVenueDay };
