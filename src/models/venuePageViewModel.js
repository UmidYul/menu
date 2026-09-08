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

// Раскладывает строки (viewed_on, view_count) по семи дням, включая дни без просмотров.
// Отдельной функцией, потому что этим пользуются два экрана: дашборд одного заведения и сводка
// сети (промт 3.6). Логика «от какой полуночи считать дни» должна быть у них одна: разъедься
// она, и суммы на двух экранах перестанут сходиться на границе суток.
function buildDailyBuckets(rows) {
  // viewed_on приходит сырой строкой 'YYYY-MM-DD' (см. config/db.js) — используем как есть, без Date.
  const countsByDate = new Map(rows.map((row) => [row.viewed_on, row.view_count]));

  // Дни считаем от UTC-полуночи — так же, как CURRENT_DATE в recordView (сессия БД в UTC),
  // чтобы бакет "сегодня" совпадал с тем днём, куда реально пишутся просмотры.
  const now = new Date();
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date(todayUtcMidnight - i * 86400000);
    days.push({ date, count: countsByDate.get(date.toISOString().slice(0, 10)) || 0 });
  }

  const maxCount = Math.max(1, ...days.map((d) => d.count));
  return days.map((d) => ({
    label: d.date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
    count: d.count,
    heightPercent: Math.max(6, Math.round((d.count / maxCount) * 100)),
  }));
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

  return {
    totalThisMonth,
    trend: computeTrend(totalThisMonth, totalLastMonth),
    daily: buildDailyBuckets(dailyResult.rows),
  };
}

module.exports = { recordView, getStats, buildDailyBuckets };
