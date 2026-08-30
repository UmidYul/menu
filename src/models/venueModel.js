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
            wifi_ssid, wifi_password, instagram_url, telegram_url, working_hours, lang_default, is_active, show_powered_by,
            logo_url, logo_thumb_url, cover_url, cover_thumb_url,
            description_ru, description_uz, cuisine_ru, cuisine_uz,
            category_label_ru, category_label_uz, district_ru, district_uz,
            email, rating, review_count
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

// photo/logo/cover *Url передаются только когда загружен новый файл — если их нет (null),
// уже сохранённое в БД изображение остаётся без изменений (COALESCE), как и для фото позиций.
// rating/review_count сюда намеренно не входят — это не бренд-данные заведения, а модерируемое
// сервисом поле доверия, его меняет только суперадмин через updateRating.
async function updateSettings(id, {
  phone, address, address2gisUrl, wifiSsid, wifiPassword, instagramUrl, telegramUrl, workingHours,
  descriptionRu, descriptionUz, cuisineRu, cuisineUz, categoryLabelRu, categoryLabelUz,
  districtRu, districtUz, email,
  logoUrl, logoThumbUrl, coverUrl, coverThumbUrl,
}) {
  const result = await pool.query(
    `UPDATE venues
     SET phone = $1, address = $2, address_2gis_url = $3,
         wifi_ssid = $4, wifi_password = $5, instagram_url = $6, telegram_url = $7, working_hours = $8,
         description_ru = $9, description_uz = $10, cuisine_ru = $11, cuisine_uz = $12,
         category_label_ru = $13, category_label_uz = $14, district_ru = $15, district_uz = $16,
         email = $17,
         logo_url = COALESCE($18, logo_url), logo_thumb_url = COALESCE($19, logo_thumb_url),
         cover_url = COALESCE($20, cover_url), cover_thumb_url = COALESCE($21, cover_thumb_url)
     WHERE id = $22
     RETURNING *`,
    [
      phone, address, address2gisUrl, wifiSsid, wifiPassword, instagramUrl, telegramUrl, workingHours,
      descriptionRu, descriptionUz, cuisineRu, cuisineUz, categoryLabelRu, categoryLabelUz,
      districtRu, districtUz, email,
      logoUrl || null, logoThumbUrl || null, coverUrl || null, coverThumbUrl || null,
      id,
    ]
  );
  return result.rows[0] || null;
}

// Рейтинг и число отзывов заведения — правит только суперадмин (см. модерационную карточку
// в /superadmin/venues/:id), сам ресторан не может накрутить себе звёзды через свои настройки.
async function updateRating(id, { rating, reviewCount }) {
  const result = await pool.query(
    'UPDATE venues SET rating = $1, review_count = $2 WHERE id = $3 RETURNING id, slug, rating, review_count',
    [rating, reviewCount, id]
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
  updateRating,
  updateSubscriptionUntil,
};
