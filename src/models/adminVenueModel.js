const { pool } = require('../config/db');

// Промт 3.6. Доступ администратора к заведениям. Единственный источник правды о том,
// к каким заведениям у человека есть доступ и с какой ролью, — таблица admin_venues.
// admins.venue_id помечена устаревшей (см. миграцию 1787508300000) и здесь не читается.

// Роли внутри заведения, от большего к меньшему.
const VENUE_ROLES = ['owner', 'manager', 'staff'];

// Список заведений администратора — вместе с тем, что нужно переключателю и сводному экрану.
// Один индексированный запрос по admin_id: он выполняется на каждый запрос к кабинету
// (см. middlewares/activeVenue.js), поэтому лишних join'ов здесь быть не должно.
// Порядок: сначала действующие, потом по названию — чтобы переключатель не прыгал.
async function listForAdmin(adminId) {
  const result = await pool.query(
    `SELECT av.venue_id AS id, av.role,
            v.name, v.slug, v.status, v.is_active
     FROM admin_venues av
     JOIN venues v ON v.id = av.venue_id
     WHERE av.admin_id = $1
     ORDER BY (v.status = 'archived'), v.name`,
    [adminId]
  );
  return result.rows;
}

// Точечная проверка доступа. Отдельно от listForAdmin: там, где нужно ответить только
// «можно или нет» (переключение заведения), тащить весь список незачем.
async function findAccess(adminId, venueId) {
  const result = await pool.query(
    'SELECT admin_id, venue_id, role FROM admin_venues WHERE admin_id = $1 AND venue_id = $2',
    [adminId, venueId]
  );
  return result.rows[0] || null;
}

// Кто имеет доступ к заведению — для суперадминки и для проверки «остался ли у заведения
// хоть один owner» перед снятием доступа.
async function listForVenue(venueId) {
  const result = await pool.query(
    `SELECT av.admin_id, av.role, a.login, a.display_name, a.is_active
     FROM admin_venues av
     JOIN admins a ON a.id = av.admin_id
     WHERE av.venue_id = $1
     ORDER BY av.role, a.login`,
    [venueId]
  );
  return result.rows;
}

// Выдача доступа. clientOrPool — чтобы вызывать в той же транзакции, что и создание
// заведения/администратора (см. leadApproval.js, superadmin.js).
async function grant(clientOrPool, { adminId, venueId, role }) {
  const executor = clientOrPool || pool;
  const result = await executor.query(
    `INSERT INTO admin_venues (admin_id, venue_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (admin_id, venue_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING admin_id, venue_id, role`,
    [adminId, venueId, role]
  );
  return result.rows[0];
}

async function revoke(adminId, venueId) {
  const result = await pool.query(
    'DELETE FROM admin_venues WHERE admin_id = $1 AND venue_id = $2 RETURNING admin_id',
    [adminId, venueId]
  );
  return result.rows[0] || null;
}

// --- сводный экран сети (промт 3.6, раздел 4) ----------------------------------------------

const SUMMARY_DAYS = 7;

// Строка таблицы «Все заведения» на каждое доступное заведение: подписка, просмотры за неделю,
// сколько позиций и сколько из них в стоп-листе.
//
// Всё одним запросом с LATERAL, а не циклом «на каждое заведение — три запроса»: у сети из
// десяти точек это была бы тридцать одна поездка в базу на одну страницу. Счётчики позиций
// идут через categories: у items нет своей venue_id, заведение у позиции — только через категорию.
//
// admin_id в WHERE — здесь и есть изоляция: заведения, которого нет в admin_venues у этого
// человека, в выборку не попадёт никаким подбором параметров.
async function summaryForAdmin(adminId) {
  const result = await pool.query(
    `SELECT av.venue_id AS id, av.role,
            v.name, v.slug, v.status, v.subscription_until, v.trial_ends_on,
            COALESCE(views.total, 0)::int AS views_week,
            COALESCE(menu.item_count, 0)::int AS item_count,
            COALESCE(menu.stopped_count, 0)::int AS stopped_count
     FROM admin_venues av
     JOIN venues v ON v.id = av.venue_id
     LEFT JOIN LATERAL (
       SELECT SUM(pv.view_count) AS total
       FROM venue_page_views pv
       WHERE pv.venue_id = av.venue_id
         AND pv.viewed_on >= CURRENT_DATE - make_interval(days => $2 - 1)
     ) views ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS item_count,
              count(*) FILTER (WHERE NOT i.is_available) AS stopped_count
       FROM items i
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = av.venue_id
     ) menu ON true
     WHERE av.admin_id = $1
     ORDER BY (v.status = 'archived'), v.name`,
    [adminId, SUMMARY_DAYS]
  );
  return result.rows;
}

// Просмотры всех заведений администратора по дням — для суммарного графика.
// Суммирование делает БД: тянуть в приложение по строке на заведение на день незачем.
async function dailyViewsForAdmin(adminId) {
  const result = await pool.query(
    `SELECT pv.viewed_on, SUM(pv.view_count)::int AS view_count
     FROM venue_page_views pv
     JOIN admin_venues av ON av.venue_id = pv.venue_id AND av.admin_id = $1
     WHERE pv.viewed_on >= CURRENT_DATE - make_interval(days => $2 - 1)
     GROUP BY pv.viewed_on
     ORDER BY pv.viewed_on`,
    [adminId, SUMMARY_DAYS]
  );
  return result.rows;
}

// Сколько у заведения владельцев. Нужно, чтобы не дать снять доступ последнему owner:
// заведение без владельца — это заведение, к которому никто не может подойти.
async function countOwners(venueId) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM admin_venues WHERE venue_id = $1 AND role = 'owner'",
    [venueId]
  );
  return result.rows[0].count;
}

module.exports = {
  VENUE_ROLES,
  SUMMARY_DAYS,
  listForAdmin,
  findAccess,
  listForVenue,
  summaryForAdmin,
  dailyViewsForAdmin,
  grant,
  revoke,
  countOwners,
};
