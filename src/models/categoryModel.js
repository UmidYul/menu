const { pool } = require('../config/db');

async function listByVenue(venueId) {
  const result = await pool.query(
    'SELECT id, venue_id, name_ru, name_uz, name_en, sort_order, is_demo FROM categories WHERE venue_id = $1 ORDER BY sort_order, id',
    [venueId]
  );
  return result.rows;
}

// item_count — все позиции категории (для бейджа "N блюда" в UI, демо в том числе — с точки
// зрения владельца это реальные строки, которые надо явно удалить, а не просто игнорировать).
// real_item_count — без демо (is_demo=false), для проверки готовности к публикации
// (venueLifecycle.checkPublishReadiness), где демо-позиции не должны засчитываться.
async function listByVenueWithCounts(venueId) {
  const result = await pool.query(
    `SELECT c.id, c.venue_id, c.name_ru, c.name_uz, c.name_en, c.sort_order, c.is_demo,
            COUNT(i.id)::int AS item_count,
            COUNT(i.id) FILTER (WHERE i.is_demo = false)::int AS real_item_count
     FROM categories c
     LEFT JOIN items i ON i.category_id = c.id
     WHERE c.venue_id = $1
     GROUP BY c.id
     ORDER BY c.sort_order, c.id`,
    [venueId]
  );
  return result.rows;
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM categories WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function countItems(categoryId) {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM items WHERE category_id = $1', [categoryId]);
  return result.rows[0].count;
}

async function create(venueId, { nameRu, nameUz, nameEn, isDemo }, client) {
  const executor = client || pool;
  const nextOrderResult = await executor.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM categories WHERE venue_id = $1',
    [venueId]
  );
  const sortOrder = nextOrderResult.rows[0].next_order;
  const result = await executor.query(
    `INSERT INTO categories (venue_id, name_ru, name_uz, name_en, sort_order, is_demo)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, venue_id, name_ru, name_uz, name_en, sort_order, is_demo`,
    [venueId, nameRu, nameUz, nameEn || null, sortOrder, Boolean(isDemo)]
  );
  return result.rows[0];
}

// Промт 1.6 — "Удалить примеры" (см. src/services/demoData.js, которая сначала удаляет
// is_demo-позиции: items.category_id — ON DELETE RESTRICT, категорию с чужими позициями
// не удалить). Фильтр по venue_id обязателен — иначе снесло бы демо-категории всех заведений.
async function removeDemoCategories(client, venueId) {
  const executor = client || pool;
  await executor.query('DELETE FROM categories WHERE venue_id = $1 AND is_demo = true', [venueId]);
}

async function update(id, { nameRu, nameUz, nameEn }) {
  const result = await pool.query(
    `UPDATE categories SET name_ru = $1, name_uz = $2, name_en = $3 WHERE id = $4
     RETURNING id, venue_id, name_ru, name_uz, name_en, sort_order`,
    [nameRu, nameUz, nameEn || null, id]
  );
  return result.rows[0] || null;
}

async function remove(id) {
  await pool.query('DELETE FROM categories WHERE id = $1', [id]);
}

async function swapOrder(client, categoryA, categoryB) {
  await client.query('UPDATE categories SET sort_order = $1 WHERE id = $2', [categoryB.sort_order, categoryA.id]);
  await client.query('UPDATE categories SET sort_order = $1 WHERE id = $2', [categoryA.sort_order, categoryB.id]);
}

module.exports = {
  listByVenue, listByVenueWithCounts, findById, countItems, create, update, remove, swapOrder, removeDemoCategories,
};
