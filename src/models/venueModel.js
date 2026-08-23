const { pool } = require('../config/db');

async function listAll() {
  const result = await pool.query(
    'SELECT id, slug, name, is_active, subscription_until FROM venues ORDER BY created_at DESC'
  );
  return result.rows;
}

async function findBySlug(slug) {
  const result = await pool.query('SELECT id FROM venues WHERE slug = $1', [slug]);
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM venues WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function create(client, { slug, name, langDefault }) {
  const result = await client.query(
    `INSERT INTO venues (slug, name, lang_default, is_active, show_powered_by)
     VALUES ($1, $2, $3, true, true)
     RETURNING id, slug, name, is_active, subscription_until`,
    [slug, name, langDefault]
  );
  return result.rows[0];
}

async function toggleActive(id) {
  const result = await pool.query(
    'UPDATE venues SET is_active = NOT is_active WHERE id = $1 RETURNING id, slug, name, is_active',
    [id]
  );
  return result.rows[0] || null;
}

module.exports = { listAll, findBySlug, findById, create, toggleActive };
