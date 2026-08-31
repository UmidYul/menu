const { pool } = require('../config/db');
const venueModel = require('./venueModel');
const { slugify } = require('../utils/slugify');

const ACTIVE_STATUSES = ['new', 'contacted', 'approved'];
const PAGE_SIZE = 25;

async function create(clientOrPool, {
  source, telegramId, telegramUsername, contactName, phone, email,
  venueName, city, venueType, comment, ipHash, userAgent,
}) {
  const executor = clientOrPool || pool;
  const result = await executor.query(
    `INSERT INTO leads (source, telegram_id, telegram_username, contact_name, phone, email,
                         venue_name, city, venue_type, comment, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      source, telegramId || null, telegramUsername || null, contactName, phone, email || null,
      venueName, city || null, venueType || null, comment || null, ipHash || null, userAgent || null,
    ]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// "Один Telegram-аккаунт = одно заведение" — тот же смысл, что и уникальный индекс в БД,
// но нужен ДО insert (индекс просто отклонит запрос, а тут можно вежливо показать статус).
async function findActiveByTelegramId(telegramId) {
  const result = await pool.query(
    `SELECT * FROM leads WHERE telegram_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [telegramId, ACTIVE_STATUSES]
  );
  return result.rows[0] || null;
}

// Для предупреждения владельцу "похожая заявка уже есть" — тот же телефон в другой активной
// заявке. excludeId — чтобы не сравнивать заявку саму с собой при повторном сохранении.
async function findOtherActiveByPhone(phone, excludeId) {
  const result = await pool.query(
    `SELECT * FROM leads WHERE phone = $1 AND status = ANY($2) AND id <> COALESCE($3, 0) ORDER BY created_at DESC`,
    [phone, ACTIVE_STATUSES, excludeId || null]
  );
  return result.rows;
}

// Веб-заявка с тем же телефоном, ещё не привязанная ни к одному Telegram-аккаунту — кандидат
// на привязку, когда тот же человек потом приходит в бота (вместо второй заявки).
async function findAttachableWebLeadByPhone(phone) {
  const result = await pool.query(
    `SELECT * FROM leads
     WHERE phone = $1 AND source = 'web' AND telegram_id IS NULL AND status = ANY($2)
     ORDER BY created_at DESC LIMIT 1`,
    [phone, ACTIVE_STATUSES]
  );
  return result.rows[0] || null;
}

async function attachTelegram(id, telegramId, telegramUsername) {
  const result = await pool.query(
    `UPDATE leads SET telegram_id = $1, telegram_username = $2 WHERE id = $3 RETURNING *`,
    [telegramId, telegramUsername || null, id]
  );
  return result.rows[0] || null;
}

async function list({ status, search, page }) {
  const conditions = [];
  const values = [];

  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(venue_name ILIKE $${values.length} OR phone ILIKE $${values.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safePage = Math.max(1, page || 1);
  const offset = (safePage - 1) * PAGE_SIZE;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET $${values.length + 1}`,
      [...values, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS count FROM leads ${where}`, values),
  ]);

  return {
    rows: rowsResult.rows,
    total: countResult.rows[0].count,
    page: safePage,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(countResult.rows[0].count / PAGE_SIZE)),
  };
}

async function countNew() {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM leads WHERE status = 'new'`);
  return result.rows[0].count;
}

async function markContacted(id, processedBy) {
  const result = await pool.query(
    `UPDATE leads SET status = 'contacted', processed_by = $1, processed_at = now() WHERE id = $2 RETURNING *`,
    [processedBy, id]
  );
  return result.rows[0] || null;
}

async function markRejected(id, { reason, processedBy }) {
  const result = await pool.query(
    `UPDATE leads SET status = 'rejected', reject_reason = $1, processed_by = $2, processed_at = now() WHERE id = $3 RETURNING *`,
    [reason, processedBy, id]
  );
  return result.rows[0] || null;
}

async function markSpam(id, processedBy) {
  const result = await pool.query(
    `UPDATE leads SET status = 'spam', processed_by = $1, processed_at = now() WHERE id = $2 RETURNING *`,
    [processedBy, id]
  );
  return result.rows[0] || null;
}

async function markApproved(client, id, { venueId, processedBy }) {
  const result = await client.query(
    `UPDATE leads SET status = 'approved', venue_id = $1, processed_by = $2, processed_at = now() WHERE id = $3 RETURNING *`,
    [venueId, processedBy, id]
  );
  return result.rows[0] || null;
}

// slug-кандидат из названия заведения, с проверкой уникальности в БД — при конфликте
// добавляет -2, -3... Отдельно от utils/slugify.js: там чистая функция без побочных эффектов,
// здесь нужен доступ к venueModel.findBySlug.
async function generateUniqueSlug(venueName) {
  const base = slugify(venueName) || 'venue';
  let candidate = base;
  let suffix = 2;
  while (await venueModel.findBySlug(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

module.exports = {
  create,
  findById,
  findActiveByTelegramId,
  findOtherActiveByPhone,
  findAttachableWebLeadByPhone,
  attachTelegram,
  list,
  countNew,
  markContacted,
  markRejected,
  markSpam,
  markApproved,
  generateUniqueSlug,
};
