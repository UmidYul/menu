const crypto = require('crypto');
const { pool } = require('../config/db');

// Тот же алфавит и та же длина, что и у кодов привязки личного аккаунта (venueTelegramLinkModel):
// код диктуют/пересылают руками в группу, поэтому без похожих символов (0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 15 * 60 * 1000;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let result = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    result += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return result;
}

// Новый код гасит предыдущие непогашенные коды ЭТОГО заведения — активным может быть только
// последний выданный (тот же приём, что у password_reset_tokens и venue_telegram_links).
async function create(venueId, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE venue_telegram_group_links SET used_at = now() WHERE venue_id = $1 AND used_at IS NULL',
      [venueId]
    );
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await client.query(
      'INSERT INTO venue_telegram_group_links (venue_id, created_by_admin_id, code, expires_at) VALUES ($1, $2, $3, $4)',
      [venueId, adminId, code, expiresAt]
    );
    await client.query('COMMIT');
    return { code, expiresAt };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Атомарный UPDATE ... RETURNING — два одновременных сообщения с одним кодом в разные группы
// не привяжут обе: вторая транзакция не найдёт непогашенную строку.
async function claim(rawCode) {
  const code = String(rawCode || '').toUpperCase();
  const result = await pool.query(
    `UPDATE venue_telegram_group_links SET used_at = now()
     WHERE code = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id, venue_id`,
    [code]
  );
  return result.rows[0] || null;
}

async function findActiveByVenue(venueId) {
  const result = await pool.query(
    'SELECT code, expires_at FROM venue_telegram_group_links WHERE venue_id = $1 AND used_at IS NULL AND expires_at > now()',
    [venueId]
  );
  return result.rows[0] || null;
}

module.exports = { create, claim, findActiveByVenue, CODE_LENGTH, CODE_ALPHABET };
