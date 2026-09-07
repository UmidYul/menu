const crypto = require('crypto');
const { pool } = require('../config/db');

// 8 символов из безопасного для URL алфавита (токен живёт в ссылке QR-кода /menu/:slug?t=<token>).
// В отличие от кодов привязки (venueTelegramLinkModel) похожие символы тут не мешают: токен
// никто не диктует и не набирает руками — его считывает камера.
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TOKEN_LENGTH = 8;

function generateToken() {
  const bytes = crypto.randomBytes(TOKEN_LENGTH);
  let result = '';
  for (let i = 0; i < TOKEN_LENGTH; i += 1) {
    result += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return result;
}

async function listByVenue(venueId) {
  const result = await pool.query(
    'SELECT * FROM venue_tables WHERE venue_id = $1 ORDER BY sort_order, id',
    [venueId]
  );
  return result.rows;
}

async function findByIdForVenue(id, venueId) {
  const result = await pool.query(
    'SELECT * FROM venue_tables WHERE id = $1 AND venue_id = $2',
    [id, venueId]
  );
  return result.rows[0] || null;
}

// Публичная сторона: стол по id из cookie — только активный. Деактивированный стол ведёт себя
// так же, как отсутствующий (гостя попросят ввести номер вручную).
async function findActiveByIdForVenue(id, venueId) {
  const result = await pool.query(
    'SELECT * FROM venue_tables WHERE id = $1 AND venue_id = $2 AND is_active = true',
    [id, venueId]
  );
  return result.rows[0] || null;
}

// Резолв токена из ссылки QR. Заведение сверяется здесь же (а не только по slug в роуте):
// токен глобально уникален, но подставить чужой токен к чужому slug всё равно не должно
// сработать — стол принадлежит конкретному заведению.
async function findActiveByToken(token, venueId) {
  const result = await pool.query(
    'SELECT * FROM venue_tables WHERE token = $1 AND venue_id = $2 AND is_active = true',
    [token, venueId]
  );
  return result.rows[0] || null;
}

// Уникальность (venue_id, number) обеспечена ограничением в БД — здесь ON CONFLICT DO NOTHING,
// чтобы массовое создание «столы 1–20» не падало целиком из-за одного уже существующего номера,
// а просто пропускало его (возвращаем реально созданные строки).
async function createMany(venueId, numbers, startSortOrder) {
  if (numbers.length === 0) return [];

  const values = [];
  const placeholders = numbers.map((number, i) => {
    const base = i * 4;
    values.push(venueId, String(number), generateToken(), startSortOrder + i);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
  });

  const result = await pool.query(
    `INSERT INTO venue_tables (venue_id, number, token, sort_order)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (venue_id, number) DO NOTHING
     RETURNING *`,
    values
  );
  return result.rows;
}

async function maxSortOrder(venueId) {
  const result = await pool.query(
    'SELECT COALESCE(MAX(sort_order), -1) AS max FROM venue_tables WHERE venue_id = $1',
    [venueId]
  );
  return Number(result.rows[0].max);
}

async function rename(id, venueId, number) {
  const result = await pool.query(
    'UPDATE venue_tables SET number = $1 WHERE id = $2 AND venue_id = $3 RETURNING *',
    [number, id, venueId]
  );
  return result.rows[0] || null;
}

async function toggleActive(id, venueId) {
  const result = await pool.query(
    'UPDATE venue_tables SET is_active = NOT is_active WHERE id = $1 AND venue_id = $2 RETURNING *',
    [id, venueId]
  );
  return result.rows[0] || null;
}

// Перевыпуск токена (QR скомпрометирован/переклеили) — старый QR со стола перестаёт работать
// сразу же: ссылка со старым токеном просто не найдёт стол и превратится в «заказ без стола».
async function regenerateToken(id, venueId) {
  const result = await pool.query(
    'UPDATE venue_tables SET token = $1 WHERE id = $2 AND venue_id = $3 RETURNING *',
    [generateToken(), id, venueId]
  );
  return result.rows[0] || null;
}

async function remove(id, venueId) {
  const result = await pool.query(
    'DELETE FROM venue_tables WHERE id = $1 AND venue_id = $2 RETURNING id, number',
    [id, venueId]
  );
  return result.rows[0] || null;
}

module.exports = {
  listByVenue,
  findByIdForVenue,
  findActiveByIdForVenue,
  findActiveByToken,
  createMany,
  maxSortOrder,
  rename,
  toggleActive,
  regenerateToken,
  remove,
  generateToken,
};
