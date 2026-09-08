const { pool } = require('../config/db');

// Промт 3.3: «один session_hash — один отзыв в 30 дней». Проверяется в БД, а не только по
// localStorage у гостя: localStorage чистится в один клик и не переживает смену браузера.
const REVIEW_COOLDOWN_DAYS = 30;
// Минимум внутренних отзывов, начиная с которого рейтинг в карточке считается по ним, а не
// по ручному значению суперадмина (промт: «внутренних отзывов >= 5»).
const MIN_REVIEWS_FOR_RATING = 5;

async function create({
  venueId, rating, comment, contact, tableId, lang, sessionHash, isSuspicious, externalTarget,
}) {
  const result = await pool.query(
    `INSERT INTO reviews (venue_id, rating, comment, contact, table_id, lang, session_hash, is_suspicious,
                          went_external, external_target)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      venueId, rating, comment, contact, tableId, lang, sessionHash, Boolean(isSuspicious),
      Boolean(externalTarget), externalTarget || null,
    ]
  );
  return result.rows[0];
}

// Оставлял ли этот гость отзыв за последние 30 дней. Возвращает саму запись, а не просто
// признак: экрану гостя полезно знать, что отзыв уже был, чтобы больше не звать.
async function findRecentBySessionHash(venueId, sessionHash) {
  if (!sessionHash) return null;
  const result = await pool.query(
    `SELECT id, created_at FROM reviews
     WHERE venue_id = $1 AND session_hash = $2
       AND created_at > now() - ($3 || ' days')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [venueId, sessionHash, String(REVIEW_COOLDOWN_DAYS)]
  );
  return result.rows[0] || null;
}

// Лимит «20 отзывов с одного IP в сутки» здесь НЕ считается: session_hash — это
// SHA-256(секрет+сутки+IP+UA), из него IP обратно не достать, а отдельную колонку с хешем IP
// заводить ради одного счётчика избыточно. Ограничение стоит на маршруте через
// express-rate-limit по req.ip (см. middlewares/rateLimit.js), как и лимит заказов в промте 2.4.

// Тот же текст отзыва подряд у этого заведения — признак накрутки. Не блокирует отправку,
// только помечает (промт: «помечать автоматически как подозрительные, но не удалять»).
async function lastCommentMatches(venueId, comment) {
  if (!comment) return false;
  const result = await pool.query(
    'SELECT comment FROM reviews WHERE venue_id = $1 ORDER BY created_at DESC LIMIT 1',
    [venueId]
  );
  const last = result.rows[0];
  return Boolean(last && last.comment && last.comment.trim() === comment.trim());
}

// Отметка «гость нажал кнопку перехода на карты». Идемпотентна и не перетирает уже
// проставленную цель: первый переход и есть тот, который интересен.
async function markWentExternal(id, target) {
  const result = await pool.query(
    `UPDATE reviews SET went_external = true, external_target = COALESCE(external_target, $1)
     WHERE id = $2 RETURNING id, went_external, external_target`,
    [target, id]
  );
  return result.rows[0] || null;
}

// Средняя внутренняя оценка и их количество. Учитываются ВСЕ отзывы, кроме помеченных спамом:
// владелец, отметив накрутку спамом, тем самым убирает её и из рейтинга.
async function ratingStats(venueId) {
  const result = await pool.query(
    `SELECT count(*)::int AS count, avg(rating)::numeric(3,2) AS average
     FROM reviews WHERE venue_id = $1 AND status <> 'spam'`,
    [venueId]
  );
  const row = result.rows[0];
  return { count: row.count, average: row.average === null ? null : Number(row.average) };
}

async function countUnread(venueId) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM reviews WHERE venue_id = $1 AND status = 'new'",
    [venueId]
  );
  return result.rows[0].count;
}

// Список с фильтрами по статусу и минимальной оценке. Фильтры приходят из query админки,
// поэтому подставляются только параметрами, без склейки SQL.
async function listByVenue(venueId, { status, rating, limit = 100 } = {}) {
  const result = await pool.query(
    `SELECT r.*, t.number AS table_number
     FROM reviews r
     LEFT JOIN venue_tables t ON t.id = r.table_id
     WHERE r.venue_id = $1
       AND ($2::text IS NULL OR r.status = $2)
       AND ($3::int IS NULL OR r.rating = $3)
     ORDER BY r.created_at DESC
     LIMIT $4`,
    [venueId, status || null, rating || null, limit]
  );
  return result.rows;
}

async function findByIdForVenue(id, venueId) {
  const result = await pool.query('SELECT * FROM reviews WHERE id = $1 AND venue_id = $2', [id, venueId]);
  return result.rows[0] || null;
}

async function updateStatus(id, venueId, status) {
  const result = await pool.query(
    'UPDATE reviews SET status = $1 WHERE id = $2 AND venue_id = $3 RETURNING *',
    [status, id, venueId]
  );
  return result.rows[0] || null;
}

async function saveOwnerNote(id, venueId, note) {
  const result = await pool.query(
    'UPDATE reviews SET owner_reply = $1, replied_at = now() WHERE id = $2 AND venue_id = $3 RETURNING *',
    [note, id, venueId]
  );
  return result.rows[0] || null;
}

// Высокие оценки за период — для еженедельной сводки в Telegram (промт: при высокой оценке
// не спамить владельца немедленно, включать в сводку).
async function countByPeriod(venueId, fromDate, toDate) {
  const result = await pool.query(
    `SELECT count(*)::int AS count, avg(rating)::numeric(3,2) AS average
     FROM reviews
     WHERE venue_id = $1 AND status <> 'spam' AND created_at >= $2 AND created_at < $3`,
    [venueId, fromDate, toDate]
  );
  const row = result.rows[0];
  return { count: row.count, average: row.average === null ? null : Number(row.average) };
}

module.exports = {
  REVIEW_COOLDOWN_DAYS,
  MIN_REVIEWS_FOR_RATING,
  create,
  findRecentBySessionHash,
  lastCommentMatches,
  markWentExternal,
  ratingStats,
  countUnread,
  listByVenue,
  findByIdForVenue,
  updateStatus,
  saveOwnerNote,
  countByPeriod,
};
