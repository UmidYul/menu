const { pool } = require('../config/db');

async function listAll() {
  const result = await pool.query(
    'SELECT id, slug, name, is_active, subscription_until, show_powered_by FROM venues ORDER BY created_at DESC'
  );
  return result.rows;
}

async function findBySlug(slug) {
  const result = await pool.query('SELECT id FROM venues WHERE slug = $1', [slug]);
  return result.rows[0] || null;
}

// Заведения, которые должны попасть в sitemap.xml — только активные, чтобы поисковик не
// индексировал страницы с "меню временно недоступно".
async function listActiveSlugs() {
  const result = await pool.query(
    'SELECT slug, created_at FROM venues WHERE is_active = true ORDER BY created_at ASC'
  );
  return result.rows;
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM venues WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function findPublicBySlug(slug) {
  const result = await pool.query(
    `SELECT id, slug, name, phone, address, address_2gis_url,
            wifi_ssid, wifi_password, instagram_url, telegram_url, working_hours, lang_default, is_active, show_powered_by
     FROM venues WHERE slug = $1`,
    [slug]
  );
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

async function toggleShowPoweredBy(id) {
  const result = await pool.query(
    'UPDATE venues SET show_powered_by = NOT show_powered_by WHERE id = $1 RETURNING id, slug, name, show_powered_by',
    [id]
  );
  return result.rows[0] || null;
}

async function updateSubscriptionUntil(client, id, subscriptionUntil) {
  const executor = client || pool;
  const result = await executor.query(
    'UPDATE venues SET subscription_until = $1 WHERE id = $2 RETURNING id, slug, name, subscription_until',
    [subscriptionUntil, id]
  );
  return result.rows[0] || null;
}

async function updateSettings(id, { phone, address, address2gisUrl, wifiSsid, wifiPassword, instagramUrl, telegramUrl, workingHours }) {
  const result = await pool.query(
    `UPDATE venues
     SET phone = $1, address = $2, address_2gis_url = $3,
         wifi_ssid = $4, wifi_password = $5, instagram_url = $6, telegram_url = $7, working_hours = $8
     WHERE id = $9
     RETURNING *`,
    [phone, address, address2gisUrl, wifiSsid, wifiPassword, instagramUrl, telegramUrl, workingHours, id]
  );
  return result.rows[0] || null;
}

module.exports = {
  listAll,
  findBySlug,
  listActiveSlugs,
  findById,
  findPublicBySlug,
  create,
  toggleActive,
  toggleShowPoweredBy,
  updateSettings,
  updateSubscriptionUntil,
};
