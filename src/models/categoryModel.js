const { pool } = require('../config/db');

async function listByVenue(venueId) {
  const result = await pool.query(
    'SELECT id, venue_id, name_ru, name_uz, sort_order FROM categories WHERE venue_id = $1 ORDER BY sort_order, id',
    [venueId]
  );
  return result.rows;
}

async function listByVenueWithCounts(venueId) {
  const result = await pool.query(
    `SELECT c.id, c.venue_id, c.name_ru, c.name_uz, c.sort_order, COUNT(i.id)::int AS item_count
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

async function create(venueId, { nameRu, nameUz }) {
  const nextOrderResult = await pool.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM categories WHERE venue_id = $1',
    [venueId]
  );
  const sortOrder = nextOrderResult.rows[0].next_order;
  const result = await pool.query(
    `INSERT INTO categories (venue_id, name_ru, name_uz, sort_order)
     VALUES ($1, $2, $3, $4)
     RETURNING id, venue_id, name_ru, name_uz, sort_order`,
    [venueId, nameRu, nameUz, sortOrder]
  );
  return result.rows[0];
}

async function update(id, { nameRu, nameUz }) {
  const result = await pool.query(
    `UPDATE categories SET name_ru = $1, name_uz = $2 WHERE id = $3
     RETURNING id, venue_id, name_ru, name_uz, sort_order`,
    [nameRu, nameUz, id]
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

module.exports = { listByVenue, listByVenueWithCounts, findById, countItems, create, update, remove, swapOrder };
