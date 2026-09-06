const crypto = require('crypto');
const { pool } = require('../config/db');

// Без похожих символов (0/O, 1/I) — тот же принцип, что у generatePassword.js, код тоже
// иногда придётся продиктовать или сверить на глаз.
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

// Новый код гасит предыдущие непогашенные коды этого админа — тот же приём, что и у
// password_reset_tokens: активным может быть только последний сгенерированный.
async function create(venueId, adminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE venue_telegram_links SET used_at = now() WHERE admin_id = $1 AND used_at IS NULL',
      [adminId]
    );
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await client.query(
      'INSERT INTO venue_telegram_links (venue_id, admin_id, code, expires_at) VALUES ($1, $2, $3, $4)',
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

// Регистронезависимо — код хранится и ищется в верхнем регистре. Атомарный UPDATE...RETURNING —
// тот же приём, что у payment_claims/password_reset_tokens: гасит гонку двойного использования.
async function claim(rawCode) {
  const code = String(rawCode || '').toUpperCase();
  const result = await pool.query(
    `UPDATE venue_telegram_links SET used_at = now()
     WHERE code = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id, venue_id, admin_id`,
    [code]
  );
  return result.rows[0] || null;
}

// Для GET /admin/password — если код уже сгенерирован и ещё жив, показываем тот же самый,
// а не заставляем жать "сгенерировать" заново при каждой перезагрузке страницы.
async function findActiveByAdmin(adminId) {
  const result = await pool.query(
    'SELECT code, expires_at FROM venue_telegram_links WHERE admin_id = $1 AND used_at IS NULL AND expires_at > now()',
    [adminId]
  );
  return result.rows[0] || null;
}

module.exports = { create, claim, findActiveByAdmin };
