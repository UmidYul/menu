const crypto = require('crypto');
const { pool } = require('../config/db');

const TOKEN_TTL_MS = 60 * 60 * 1000;
// Промт 3.5: ссылка быстрого входа сотрудника живёт 24 часа — владелец пересылает её официанту
// в Telegram и не должен гнаться за часовым окном восстановления пароля. Механика та же самая
// (одноразовый токен, в БД только хеш), отличается лишь срок, поэтому отдельной таблицы нет.
const STAFF_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Создание нового токена сразу гасит все непогашенные токены этого админа (промт 1.5: "при
// создании нового токена все предыдущие для этого пользователя помечаются использованными") —
// возвращает СЫРОЕ значение (для ссылки в письме/сообщении), в БД остаётся только его хеш.
async function create(adminId, { requestedIpHash, ttlMs } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE password_reset_tokens SET used_at = now() WHERE admin_id = $1 AND used_at IS NULL',
      [adminId]
    );
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + (ttlMs || TOKEN_TTL_MS));
    await client.query(
      `INSERT INTO password_reset_tokens (admin_id, token_hash, expires_at, requested_ip_hash)
       VALUES ($1, $2, $3, $4)`,
      [adminId, tokenHash, expiresAt, requestedIpHash || null]
    );
    await client.query('COMMIT');
    return rawToken;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Только для GET-показа формы — сообщает, стоит ли вообще рисовать форму смены пароля или
// сразу "ссылка недействительна". Не мутирует ничего, финальная проверка — в claimToken ниже.
async function findValidByRawToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  const result = await pool.query(
    'SELECT id, admin_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
    [tokenHash]
  );
  return result.rows[0] || null;
}

// Атомарно "забирает" токен на использование — WHERE used_at IS NULL AND expires_at > now()
// гарантирует, что при гонке (двойной клик, повтор той же ссылки) только один из параллельных
// вызовов получит непустой результат; остальные видят "уже использован/невалиден", как и
// требует edge case промта. Админ, удалённый до истечения токена, тоже покрыт: FK на admin_id
// с ON DELETE CASCADE унесёт с собой и строку токена, claimToken просто ничего не найдёт.
async function claimToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  const result = await pool.query(
    `UPDATE password_reset_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING admin_id`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

module.exports = { create, findValidByRawToken, claimToken, TOKEN_TTL_MS, STAFF_INVITE_TTL_MS };
