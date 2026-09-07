const { pool } = require('../config/db');

// Промт 3.2, edge case «владелец сам открывает своё меню и накручивает просмотры». Пишется на
// каждый запрос авторизованного venue_admin (src/middlewares/auth.js) — ON CONFLICT DO NOTHING,
// потому что тройка (venue_id, session_hash, occurred_on) и так уникальна на весь день: после
// первой записи за сутки все следующие запросы того же администратора — чистый no-op.
async function recordIfMissing(venueId, sessionHashValue, occurredOn) {
  await pool.query(
    `INSERT INTO admin_session_hashes (venue_id, session_hash, occurred_on)
     VALUES ($1, $2, $3)
     ON CONFLICT (venue_id, session_hash, occurred_on) DO NOTHING`,
    [venueId, sessionHashValue, occurredOn]
  );
}

// Множество session_hash, замеченных у владельца этого заведения за период — для фильтрации
// menu_events при исключении собственных просмотров (analyticsAggregation.js/adminAnalytics.js).
async function listHashesForVenue(venueId, fromDate, toDate) {
  const result = await pool.query(
    'SELECT DISTINCT session_hash FROM admin_session_hashes WHERE venue_id = $1 AND occurred_on BETWEEN $2 AND $3',
    [venueId, fromDate, toDate]
  );
  return result.rows.map((row) => row.session_hash);
}

module.exports = { recordIfMissing, listHashesForVenue };
