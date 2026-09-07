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

async function setTelegramMessageId(callId, messageId) {
  await pool.query('UPDATE waiter_calls SET telegram_message_id = $1 WHERE id = $2', [messageId, callId]);
}

module.exports = {
  create,
  findById,
  findRecentForTable,
  countRecentBySessionHash,
  markAcknowledged,
  setTelegramMessageId,
};
