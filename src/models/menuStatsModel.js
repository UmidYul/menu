const { pool } = require('../config/db');

const UPSERT_COLUMNS = ['venue_id', 'stat_on', 'metric', 'dimension', 'value'];

// Промт 3.2. Пересчёт дня полностью заменяет прежние значения (ON CONFLICT ... DO UPDATE),
// а не прибавляет к ним — src/services/analyticsAggregation.js каждый раз считает счётчик
// заново от сырых menu_events, так что повторный/более частый запуск тика идемпотентен.
async function upsertBatch(rows) {
  if (rows.length === 0) return;

  const values = [];
  const placeholders = rows.map((row, i) => {
    const base = i * UPSERT_COLUMNS.length;
    UPSERT_COLUMNS.forEach((col) => values.push(row[col]));
    return `(${UPSERT_COLUMNS.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  await pool.query(
    `INSERT INTO menu_stats_daily (${UPSERT_COLUMNS.join(', ')})
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (venue_id, stat_on, metric, dimension) DO UPDATE SET value = EXCLUDED.value`,
    values
  );
}

// Промт 3.2, дашборд аналитики. Один диапазон дат, произвольный набор метрик — читающая
// сторона сама решает, как сгруппировать/просуммировать строки (по dimension, по stat_on, и
// то и другое сразу и т.п.), модель отдаёт их как есть, без предположений о форме результата.
async function listForPeriod(venueId, metrics, fromDate, toDate) {
  const result = await pool.query(
    `SELECT stat_on, metric, dimension, value FROM menu_stats_daily
     WHERE venue_id = $1 AND metric = ANY($2) AND stat_on BETWEEN $3 AND $4
     ORDER BY stat_on`,
    [venueId, metrics, fromDate, toDate]
  );
  return result.rows;
}

module.exports = { upsertBatch, listForPeriod, OWNER_EXCLUDED_PREFIX: 'owner_excluded:' };
