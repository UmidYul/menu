const { pool } = require('../config/db');

const COLUMNS = [
  'venue_id', 'event_type', 'item_id', 'category_id', 'table_id',
  'query', 'value', 'lang', 'source', 'session_hash', 'device',
];

// Промт 3.2. Один параметризованный многострочный INSERT на всю пачку (до 100 событий за раз,
// ограничение — в src/services/eventTracking.js) вместо цикла из отдельных INSERT — вставка не
// должна тормозить ответ /api/events, а событий за один sendBeacon может быть несколько.
// events — уже провалидированные и нормализованные объекты (eventTracking.normalizeEvent),
// сюда не должно долетать что-то, не прошедшее zod.
async function insertBatch(events) {
  if (events.length === 0) return;

  const values = [];
  const rows = events.map((event, i) => {
    const base = i * COLUMNS.length;
    COLUMNS.forEach((col) => values.push(event[col] === undefined ? null : event[col]));
    return `(${COLUMNS.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  await pool.query(
    `INSERT INTO menu_events (${COLUMNS.join(', ')}) VALUES ${rows.join(', ')}`,
    values
  );
}

async function insertOne(event) {
  return insertBatch([event]);
}

// Заведения, у которых вообще было хоть одно событие в окне [from, to) — агрегации (см.
// src/services/analyticsAggregation.js) нет смысла запускать для заведений без единого события
// за день, поэтому список берём из самих событий, а не из общего списка всех заведений.
async function listVenuesWithEventsBetween(from, to) {
  const result = await pool.query(
    'SELECT DISTINCT venue_id FROM menu_events WHERE created_at >= $1 AND created_at < $2',
    [from, to]
  );
  return result.rows.map((row) => row.venue_id);
}

// Один сгруппированный подсчёт: сколько событий типа eventType у заведения за окно [from, to),
// с группировкой по колонке groupBy (item_id/query/lang/device/source/table_id и т.п.) —
// то есть ровно то, что нужно на выходе как (dimension, value) пары для menu_stats_daily.
// groupBy передаётся только из кода этого файла (см. функции ниже), никогда напрямую из
// пользовательского ввода — небезопасной интерполяции идентификатора в SQL тут не происходит.
// excludeHashes (промт 3.2, "не учитывать мои просмотры") — необязательный список session_hash,
// которые исключаются из подсчёта; пустой массив/undefined означает "без исключений". Используется
// как для обычных агрегатов, так и для их owner_excluded-варианта (см. analyticsAggregation.js).
function excludeClause(excludeHashes, paramIndex) {
  return excludeHashes && excludeHashes.length > 0 ? ` AND NOT (session_hash = ANY($${paramIndex}))` : '';
}

async function countGroupedByColumn(venueId, eventType, groupByColumn, from, to, excludeHashes) {
  const params = [venueId, eventType, from, to];
  const clause = excludeClause(excludeHashes, 5);
  if (clause) params.push(excludeHashes);
  const result = await pool.query(
    `SELECT ${groupByColumn}::text AS dimension, count(*)::int AS value
     FROM menu_events
     WHERE venue_id = $1 AND event_type = $2 AND created_at >= $3 AND created_at < $4
       AND ${groupByColumn} IS NOT NULL${clause}
     GROUP BY ${groupByColumn}`,
    params
  );
  return result.rows;
}

// Тот же подсчёт, но по часу суток (0..23, UTC — как и весь остальной проект) вместо колонки —
// нужен отдельно, потому что группировка идёт по выражению, а не по самой колонке created_at.
async function countGroupedByHour(venueId, eventType, from, to, excludeHashes) {
  const params = [venueId, eventType, from, to];
  const clause = excludeClause(excludeHashes, 5);
  if (clause) params.push(excludeHashes);
  const result = await pool.query(
    `SELECT extract(hour FROM created_at)::text AS dimension, count(*)::int AS value
     FROM menu_events
     WHERE venue_id = $1 AND event_type = $2 AND created_at >= $3 AND created_at < $4${clause}
     GROUP BY 1`,
    params
  );
  return result.rows;
}

async function countTotal(venueId, eventType, from, to, excludeHashes) {
  const params = [venueId, eventType, from, to];
  const clause = excludeClause(excludeHashes, 5);
  if (clause) params.push(excludeHashes);
  const result = await pool.query(
    `SELECT count(*)::int AS value FROM menu_events WHERE venue_id = $1 AND event_type = $2 AND created_at >= $3 AND created_at < $4${clause}`,
    params
  );
  return result.rows[0].value;
}

// Сырые события старше 180 дней удаляются пачками (промт 3.2), а не одним DELETE — на большой
// таблице это была бы одна долгая транзакция с длинной блокировкой. Возвращает число удалённых
// строк — вызывающий код (analyticsAggregation.js) крутит цикл, пока не получит 0.
async function deleteOlderThanBatch(cutoffDate, batchSize) {
  const result = await pool.query(
    `DELETE FROM menu_events WHERE id IN (
       SELECT id FROM menu_events WHERE created_at < $1 LIMIT $2
     )`,
    [cutoffDate, batchSize]
  );
  return result.rowCount;
}

module.exports = {
  insertBatch,
  insertOne,
  listVenuesWithEventsBetween,
  countGroupedByColumn,
  countGroupedByHour,
  countTotal,
  deleteOlderThanBatch,
};
