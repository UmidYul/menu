const { pool } = require('../config/db');

// Один запрос с агрегатами вместо девяти отдельных (промт 1.6) — четыре скалярных subquery
// за один round-trip. is_demo=false исключает демо-данные из счётчиков "5 позиций"/"фото у 3-х"
// (создание категории — исключение, см. src/services/onboarding.js).
async function getChecklistCounts(venueId) {
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM categories WHERE venue_id = $1)::int AS category_count,
       (SELECT COUNT(*) FROM items i JOIN categories c ON c.id = i.category_id
          WHERE c.venue_id = $1 AND i.is_demo = false)::int AS item_count,
       (SELECT COUNT(*) FROM items i JOIN categories c ON c.id = i.category_id
          WHERE c.venue_id = $1 AND i.is_demo = false AND i.photo_url IS NOT NULL)::int AS photo_count,
       EXISTS (SELECT 1 FROM admins WHERE venue_id = $1 AND telegram_id IS NOT NULL) AS has_telegram`,
    [venueId]
  );
  return result.rows[0];
}

module.exports = { getChecklistCounts };
