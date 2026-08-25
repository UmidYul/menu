const { pool } = require('../config/db');

// Инкрементирует счётчик уникальных просмотров публичного меню заведения за сегодняшний день.
// Вызывается из publicMenu.renderMenuPage не при каждом рендере, а только когда у гостя ещё
// нет cookie-метки за сегодня (см. shouldCountView) — переключение категории/языка или
// обновление страницы одним и тем же гостем не завышает счётчик.
async function recordView(venueId) {
  await pool.query(
    `INSERT INTO venue_page_views (venue_id, viewed_on, view_count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (venue_id, viewed_on)
     DO UPDATE SET view_count = venue_page_views.view_count + 1`,
    [venueId]
  );
}

// null означает "нет данных за прошлый месяц" (новое заведение) — в таком случае
// проценту неоткуда взяться, и его лучше не показывать, чем показать вводящее в заблуждение число.
function computeTrend(current, previous) {
  if (previous <= 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

async function getStats(venueId) {
  const [totalsResult, dailyResult] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(SUM(view_count) FILTER (WHERE viewed_on >= date_trunc('month', CURRENT_DATE)), 0)::int AS this_month,
         COALESCE(SUM(view_count) FILTER (
           WHERE viewed_on >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
             AND viewed_on < date_trunc('month', CURRENT_DATE)
         ), 0)::int AS last_month
       FROM venue_page_views WHERE venue_id = $1`,
      [venueId]
    ),
    pool.query(
      `SELECT viewed_on, view_count FROM venue_page_views
       WHERE venue_id = $1 AND viewed_on >= CURRENT_DATE - INTERVAL '6 days'
       ORDER BY viewed_on`,
      [venueId]
    ),
  ]);

  const { this_month: totalThisMonth, last_month: totalLastMonth } = totalsResult.rows[0];
  // viewed_on приходит сырой строкой 'YYYY-MM-DD' (см. config/db.js) — используем как есть, без Date.
  const countsByDate = new Map(dailyResult.rows.map((row) => [row.viewed_on, row.view_count]));

  // Дни считаем от UTC-полуночи — так же, как CURRENT_DATE в recordView (сессия БД в UTC),
  // чтобы бакет "сегодня" совпадал с тем днём, куда реально пишутся просмотры.
  const days = [];
  const todayUtcMidnight = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date(todayUtcMidnight - i * 86400000);
    const key = date.toISOString().slice(0, 10);
    days.push({ date, count: countsByDate.get(key) || 0 });
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count));

  return {
    totalThisMonth,
    trend: computeTrend(totalThisMonth, totalLastMonth),
    daily: days.map((d) => ({
      label: d.date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      count: d.count,
      heightPercent: Math.max(6, Math.round((d.count / maxCount) * 100)),
    })),
  };
}

module.exports = { recordView, getStats };
