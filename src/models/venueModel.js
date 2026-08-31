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
// индексировал страницы с "меню временно недоступно". enabled_langs/lang_default нужны, чтобы
// проставить в sitemap только реально включённые языковые альтернативы.
async function listActiveSlugs() {
  const result = await pool.query(
    'SELECT slug, created_at, enabled_langs, lang_default FROM venues WHERE is_active = true ORDER BY created_at ASC'
  );
  return result.rows;
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM venues WHERE id = $1', [id]);
  return result.rows[0] || null;
}

// Лёгкий запрос без остального профиля — нужен там, где известен только venueId и требуется
// решить, показывать ли поля _en в форме (adminItems/adminCategories).
async function getLangSettings(venueId) {
  const result = await pool.query('SELECT lang_default, enabled_langs FROM venues WHERE id = $1', [venueId]);
  return result.rows[0] || null;
}

async function findPublicBySlug(slug) {
  const result = await pool.query(
    `SELECT id, slug, name, phone, address, address_2gis_url,
            wifi_ssid, wifi_password, instagram_url, telegram_url, working_hours, lang_default,
            enabled_langs, is_active, show_powered_by,
            logo_url, logo_thumb_url, cover_url, cover_thumb_url,
            description_ru, description_uz, description_en, cuisine_ru, cuisine_uz, cuisine_en,
            category_label_ru, category_label_uz, category_label_en,
            district_ru, district_uz, district_en,
            email, rating, review_count
     FROM venues WHERE slug = $1`,
    [slug]
  );
  return result.rows[0] || null;
}

// status/isActive опциональны и по умолчанию сохраняют прежнее поведение (создание заведения
// суперадмином вручную — сразу 'active' и на виду). Заявка на подключение (leadModel/через бота
// или суперадминку) передаёт status:'draft', isActive:false явно — до 1.3 у нас нет отдельной
// страницы-заглушки для draft, is_active:false отдаёт уже существующую "меню недоступно".
async function create(client, { slug, name, langDefault, status, isActive }) {
  const result = await client.query(
    `INSERT INTO venues (slug, name, lang_default, status, is_active, show_powered_by)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id, slug, name, status, is_active, subscription_until`,
    [slug, name, langDefault, status || 'active', isActive === undefined ? true : isActive]
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
  descriptionRu, descriptionUz, descriptionEn, cuisineRu, cuisineUz, cuisineEn,
  categoryLabelRu, categoryLabelUz, categoryLabelEn, districtRu, districtUz, districtEn, email,
  enabledLangs, langDefault,
  logoUrl, logoThumbUrl, coverUrl, coverThumbUrl,
}) {
  const result = await pool.query(
    `UPDATE venues
     SET phone = $1, address = $2, address_2gis_url = $3,
         wifi_ssid = $4, wifi_password = $5, instagram_url = $6, telegram_url = $7, working_hours = $8,
         description_ru = $9, description_uz = $10, description_en = $11,
         cuisine_ru = $12, cuisine_uz = $13, cuisine_en = $14,
         category_label_ru = $15, category_label_uz = $16, category_label_en = $17,
         district_ru = $18, district_uz = $19, district_en = $20,
         email = $21, enabled_langs = $22, lang_default = $23,
         logo_url = COALESCE($24, logo_url), logo_thumb_url = COALESCE($25, logo_thumb_url),
         cover_url = COALESCE($26, cover_url), cover_thumb_url = COALESCE($27, cover_thumb_url)
     WHERE id = $28
     RETURNING *`,
    [
      phone, address, address2gisUrl, wifiSsid, wifiPassword, instagramUrl, telegramUrl, workingHours,
      descriptionRu, descriptionUz, descriptionEn, cuisineRu, cuisineUz, cuisineEn,
      categoryLabelRu, categoryLabelUz, categoryLabelEn, districtRu, districtUz, districtEn,
      email, enabledLangs, langDefault,
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
  getLangSettings,
  findPublicBySlug,
  create,
  toggleActive,
  toggleShowPoweredBy,
  updateSettings,
  updateRating,
  updateSubscriptionUntil,
};
