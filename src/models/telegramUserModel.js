const { pool } = require('../config/db');

async function findById(telegramId) {
  const result = await pool.query('SELECT * FROM telegram_users WHERE telegram_id = $1', [telegramId]);
  return result.rows[0] || null;
}

// Вызывается на каждое входящее обновление от пользователя: создаёт запись при первом контакте
// (lang — из ctx.from.language_code, определяется вызывающим кодом) или обновляет username/
// first_name (могли смениться в Telegram) и last_seen_at у уже существующей. lang у существующей
// записи здесь НЕ трогаем — дальше язык меняется только явно, через /lang.
async function touch(telegramId, { username, firstName, lang }) {
  const existing = await pool.query('SELECT 1 FROM telegram_users WHERE telegram_id = $1', [telegramId]);
  const isNew = existing.rows.length === 0;

  const result = await pool.query(
    `INSERT INTO telegram_users (telegram_id, username, first_name, lang)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE
       SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_seen_at = now()
     RETURNING *`,
    [telegramId, username || null, firstName || null, lang || 'ru']
  );
  return { user: result.rows[0], isNew };
}

async function setLang(telegramId, lang) {
  const result = await pool.query(
    'UPDATE telegram_users SET lang = $1 WHERE telegram_id = $2 RETURNING *',
    [lang, telegramId]
  );
  return result.rows[0] || null;
}

async function setBlocked(telegramId, isBlocked) {
  await pool.query('UPDATE telegram_users SET is_blocked = $1 WHERE telegram_id = $2', [isBlocked, telegramId]);
}

module.exports = { findById, touch, setLang, setBlocked };
