const crypto = require('crypto');
const { pool } = require('../config/db');

function generatePublicToken() {
  return crypto.randomBytes(16).toString('base64url');
}

// Заказ и его позиции пишутся одной транзакцией: «полузаказ» без строк не должен существовать
// ни при какой ошибке на середине вставки.
async function create(venue, { tableId, tableNumber, total, currency, comment, guestLang, sessionHash, lines }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `INSERT INTO orders (venue_id, table_id, table_number_snapshot, total, currency, comment, guest_lang, session_hash, public_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [venue.id, tableId, tableNumber, total, currency, comment, guestLang, sessionHash, generatePublicToken()]
    );
    const order = orderResult.rows[0];

    for (const line of lines) {
      // eslint-disable-next-line no-await-in-loop -- позиций в заказе единицы, отдельный
      // многострочный INSERT ради них усложнил бы чтение без выигрыша.
      await client.query(
        `INSERT INTO order_items (order_id, item_id, name_snapshot, price_snapshot, qty, options_snapshot, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, line.itemId, line.name, line.unitPrice, line.qty, JSON.stringify(line.options || []), line.lineTotal]
      );
    }

    await client.query('COMMIT');
    return order;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function findByPublicToken(token) {
  const result = await pool.query('SELECT * FROM orders WHERE public_token = $1', [token]);
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function listItems(orderId) {
  const result = await pool.query(
    'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
    [orderId]
  );
  return result.rows;
}

// Идемпотентная смена статуса: условие на текущий статус прямо в UPDATE (тот же приём, что у
// payment_claims и password_reset_tokens). Два официанта, нажавшие «Принят» одновременно,
// получат — один успех, второй null, и сообщение не будет переписано дважды.
async function markAccepted(orderId, telegramUserId) {
  const result = await pool.query(
    `UPDATE orders SET status = 'accepted', accepted_at = now(), accepted_by_tg_id = $1
     WHERE id = $2 AND status = 'new'
     RETURNING *`,
    [telegramUserId, orderId]
  );
  return result.rows[0] || null;
}

// «Готово» допустимо и сразу из 'new' (заказ отдали, не нажав «Принят») — поэтому в условии
// оба статуса, а не только 'accepted'.
async function markDone(orderId, telegramUserId) {
  const result = await pool.query(
    `UPDATE orders SET status = 'done', accepted_by_tg_id = COALESCE(accepted_by_tg_id, $1),
            accepted_at = COALESCE(accepted_at, now())
     WHERE id = $2 AND status IN ('new', 'accepted')
     RETURNING *`,
    [telegramUserId, orderId]
  );
  return result.rows[0] || null;
}

async function setTelegramMessageId(orderId, messageId) {
  await pool.query('UPDATE orders SET telegram_message_id = $1 WHERE id = $2', [messageId, orderId]);
}

// Антиспам (промт 2.4): «не больше 3 заказов с одного session_hash в час».
async function countRecentBySessionHash(sessionHash, sinceMs) {
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM orders
     WHERE session_hash = $1 AND created_at > now() - ($2 || ' milliseconds')::interval`,
    [sessionHash, String(sinceMs)]
  );
  return result.rows[0].count;
}

module.exports = {
  create,
  findByPublicToken,
  findById,
  listItems,
  markAccepted,
  markDone,
  setTelegramMessageId,
  countRecentBySessionHash,
};
