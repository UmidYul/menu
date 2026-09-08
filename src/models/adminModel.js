const { pool } = require('../config/db');

const BASE_FIELDS = `a.id, a.login, a.password_hash, a.role, a.venue_id, a.is_active,
            a.must_change_password, a.email, a.telegram_id, a.failed_login_count, a.display_name,
            v.is_active AS venue_is_active, v.name AS venue_name, v.slug AS venue_slug,
            v.owner_telegram_id AS venue_owner_telegram_id, v.status AS venue_status`;

async function findByLogin(login) {
  const result = await pool.query(
    `SELECT ${BASE_FIELDS}
     FROM admins a
     LEFT JOIN venues v ON v.id = a.venue_id
     WHERE a.login = $1`,
    [login]
  );
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await pool.query(
    `SELECT ${BASE_FIELDS}
     FROM admins a
     LEFT JOIN venues v ON v.id = a.venue_id
     WHERE a.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Восстановление по email ИЛИ логину, одним полем формы (промт 1.5). Email сравнивается без
// учёта регистра (обычная практика для почты), логин — как и везде в проекте, точным совпадением.
async function findByEmailOrLogin(value) {
  const result = await pool.query(
    `SELECT ${BASE_FIELDS}
     FROM admins a
     LEFT JOIN venues v ON v.id = a.venue_id
     WHERE LOWER(a.email) = LOWER($1) OR a.login = $1`,
    [value]
  );
  return result.rows[0] || null;
}

async function findByTelegramId(telegramId) {
  const result = await pool.query(
    `SELECT ${BASE_FIELDS}
     FROM admins a
     LEFT JOIN venues v ON v.id = a.venue_id
     WHERE a.telegram_id = $1`,
    [telegramId]
  );
  return result.rows[0] || null;
}

async function create(client, {
  venueId, login, passwordHash, role, mustChangePassword = false, email = null, displayName = null,
}) {
  const result = await client.query(
    `INSERT INTO admins (venue_id, login, password_hash, role, must_change_password, email, display_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, login, role, venue_id, must_change_password, email, display_name`,
    [venueId, login, passwordHash, role, mustChangePassword, email, displayName]
  );
  return result.rows[0];
}

// --- сотрудники заведения (промт 3.5) --------------------------------------------------------
// Везде venue_id входит в WHERE самого запроса: владелец одного заведения не должен уметь
// увидеть или тронуть сотрудника другого, даже подставив чужой id в адрес.

async function listStaffByVenue(venueId) {
  const result = await pool.query(
    `SELECT id, login, display_name, is_active, must_change_password, created_at
     FROM admins
     WHERE venue_id = $1 AND role = 'staff'
     ORDER BY is_active DESC, created_at DESC`,
    [venueId]
  );
  return result.rows;
}

// Считаем только действующих: уволенный сотрудник остаётся в базе ради читаемости логов
// (см. edge case промта), но место в лимите не занимает.
async function countActiveStaff(venueId) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM admins WHERE venue_id = $1 AND role = 'staff' AND is_active = true",
    [venueId]
  );
  return result.rows[0].count;
}

async function findStaffForVenue(id, venueId) {
  const result = await pool.query(
    "SELECT id, login, display_name, is_active, venue_id FROM admins WHERE id = $1 AND venue_id = $2 AND role = 'staff'",
    [id, venueId]
  );
  return result.rows[0] || null;
}

// Деактивация и возврат в строй — одна функция: увольнение в этом продукте обратимо
// (сотрудник вернулся после сезона), а удаления нет вовсе.
// Сброс пароля сотрудника владельцем. Отдельная функция, а не updatePassword + правка флага:
// updatePassword гасит must_change_password (там это верно — человек сам придумал пароль),
// а здесь пароль придумали ЗА него, и сменить его он обязан. Одним UPDATE, чтобы не было
// промежутка, в котором флаг уже неверен.
async function resetStaffPassword(id, venueId, passwordHash) {
  const result = await pool.query(
    `UPDATE admins SET password_hash = $3, must_change_password = true, failed_login_count = 0
     WHERE id = $1 AND venue_id = $2 AND role = 'staff'
     RETURNING id, login, display_name`,
    [id, venueId, passwordHash]
  );
  return result.rows[0] || null;
}

async function setStaffActive(id, venueId, isActive) {
  const result = await pool.query(
    `UPDATE admins SET is_active = $3
     WHERE id = $1 AND venue_id = $2 AND role = 'staff'
     RETURNING id, login, display_name, is_active`,
    [id, venueId, isActive]
  );
  return result.rows[0] || null;
}

// Смена пароля (принудительная первая или обычная из /admin/password) — гасит одноразовый флаг
// и счётчик неудачных входов заодно: новый пароль означает, что владелец аккаунта снова
// подтвердил, что это он, нет смысла нести старый счётчик дальше.
async function updatePassword(id, passwordHash) {
  const result = await pool.query(
    `UPDATE admins SET password_hash = $2, must_change_password = false, failed_login_count = 0
     WHERE id = $1
     RETURNING id, login, role, venue_id`,
    [id, passwordHash]
  );
  return result.rows[0] || null;
}

async function incrementFailedLogin(id) {
  const result = await pool.query(
    'UPDATE admins SET failed_login_count = failed_login_count + 1 WHERE id = $1 RETURNING failed_login_count',
    [id]
  );
  return result.rows[0] ? result.rows[0].failed_login_count : null;
}

async function resetFailedLogin(id) {
  await pool.query('UPDATE admins SET failed_login_count = 0 WHERE id = $1', [id]);
}

async function setTelegramId(client, adminId, telegramId) {
  const result = await client.query(
    'UPDATE admins SET telegram_id = $2 WHERE id = $1 RETURNING id, login, venue_id',
    [adminId, telegramId]
  );
  return result.rows[0] || null;
}

async function clearTelegramId(client, adminId) {
  await client.query('UPDATE admins SET telegram_id = NULL WHERE id = $1', [adminId]);
}

module.exports = {
  listStaffByVenue,
  countActiveStaff,
  findStaffForVenue,
  setStaffActive,
  resetStaffPassword,
  findByLogin,
  findById,
  findByEmailOrLogin,
  findByTelegramId,
  create,
  updatePassword,
  incrementFailedLogin,
  resetFailedLogin,
  setTelegramId,
  clearTelegramId,
};
