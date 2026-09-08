const { pool } = require('../config/db');

async function create({ venueId, tableId, tableNumber, callType, sessionHash, guestLang }) {
  const result = await pool.query(
    `INSERT INTO waiter_calls (venue_id, table_id, table_number_snapshot, call_type, session_hash, guest_lang)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [venueId, tableId, tableNumber, callType, sessionHash, guestLang]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM waiter_calls WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// Кулдаун «один вызов со стола в 2 минуты» (промт 2.4). Считается по столу, а не по гостю:
// двое за одним столом не должны звать официанта дважды подряд.
async function findRecentForTable(tableId, withinMs) {
  const result = await pool.query(
    `SELECT id FROM waiter_calls
     WHERE table_id = $1 AND created_at > now() - ($2 || ' milliseconds')::interval
     ORDER BY created_at DESC LIMIT 1`,
    [tableId, String(withinMs)]
  );
  return result.rows[0] || null;
}

async function countRecentBySessionHash(sessionHash, sinceMs) {
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM waiter_calls
     WHERE session_hash = $1 AND created_at > now() - ($2 || ' milliseconds')::interval`,
    [sessionHash, String(sinceMs)]
  );
  return result.rows[0].count;
}

// Идемпотентно, как и у заказов: первый нажавший «Иду» забирает вызов, второй получает null
// и не переписывает сообщение повторно.
async function markAcknowledged(callId, telegramUserId) {
  const result = await pool.query(
    `UPDATE waiter_calls SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by_tg_id = $1
     WHERE id = $2 AND status = 'new'
     RETURNING *`,
    [telegramUserId, callId]
  );
  return result.rows[0] || null;
}

// Промт 3.5. Список вызовов для экрана официанта: последние за смену, свежие сверху.
// Ограничение по времени, а не только по количеству — вчерашние вызовы официанту не нужны,
// а список без верхней границы однажды станет длинным.
async function listRecentByVenue(venueId, { withinMs, limit = 50 }) {
  const result = await pool.query(
    `SELECT w.id, w.table_id, w.table_number_snapshot, w.call_type, w.status, w.guest_lang,
            w.created_at, w.acknowledged_at,
            COALESCE(a.display_name, a.login) AS acknowledged_by_name
     FROM waiter_calls w
     LEFT JOIN admins a ON a.id = w.acknowledged_by_admin_id
     WHERE w.venue_id = $1 AND w.created_at > now() - ($2 || ' milliseconds')::interval
     ORDER BY w.created_at DESC
     LIMIT $3`,
    [venueId, String(withinMs), limit]
  );
  return result.rows;
}

// Подтверждение с экрана официанта. Идемпотентно ровно так же, как markAcknowledged из бота
// (WHERE status = 'new'): если вызов уже приняли — в группе или на другом телефоне — второй
// вызов вернёт null, и интерфейс просто покажет актуальное состояние вместо ошибки.
// venue_id в WHERE: чужой вызов не подтвердить даже подставленным id.
async function markAcknowledgedByAdmin(callId, venueId, adminId) {
  const result = await pool.query(
    `UPDATE waiter_calls
     SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by_admin_id = $3
     WHERE id = $1 AND venue_id = $2 AND status = 'new'
     RETURNING *`,
    [callId, venueId, adminId]
  );
  return result.rows[0] || null;
}

// Вызов этого заведения по id — нужен, чтобы отличить «чужой вызов» от «своего, но уже
// принятого»: markAcknowledgedByAdmin на оба случая возвращает null, а ответы должны быть
// разными (404 против «уже приняли»).
async function findByIdForVenue(id, venueId) {
  const result = await pool.query('SELECT * FROM waiter_calls WHERE id = $1 AND venue_id = $2', [id, venueId]);
  return result.rows[0] || null;
}

async function setTelegramMessageId(callId, messageId) {
  await pool.query('UPDATE waiter_calls SET telegram_message_id = $1 WHERE id = $2', [messageId, callId]);
}

module.exports = {
  create,
  findById,
  findRecentForTable,
  countRecentBySessionHash,
  markAcknowledged,
  markAcknowledgedByAdmin,
  findByIdForVenue,
  listRecentByVenue,
  setTelegramMessageId,
};
