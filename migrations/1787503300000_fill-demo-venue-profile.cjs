/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

const SLUG = 'demo';

// Полная карточка demo-заведения — чтобы /menu/demo и превью в /admin показывали все
// возможности публичной страницы (обложка, логотип, Wi-Fi, соцсети, район/кухня, рейтинг),
// а не только меню. Логотип и обложка — уже используемые в этом же фикстуре фото блюд
// (см. migrations/data/odesa-menu.json / 1787502500000_replace-demo-venue-menu.cjs), а не
// новые внешние ссылки: они гарантированно рабочие, раз уже используются позициями меню.
const COVER_URL = 'https://storage.ma-emirates.com/storage/26/03/VuFooWPs5OcqtxHVmt7xm1KukjusSJUOprUTmF1N.webp';
const LOGO_URL = 'https://storage.ma-emirates.com/storage/26/03/laDk2BbKvVVHgBUXoUNuEJyu37Qj1tFb0eBSWzhn.webp';

const PROFILE = {
  logo_url: LOGO_URL,
  logo_thumb_url: LOGO_URL,
  cover_url: COVER_URL,
  cover_thumb_url: COVER_URL,
  description_ru: 'Домашняя одесская кухня и авторские блюда в уютной атмосфере: блины, пельмени, супы и десерты — каждый день свежее и с любовью.',
  description_uz: "Uyga xos Odessa taomlari va mualliflik retseptlari: blinchiklar, pelmenlar, sho'rvalar va shirinliklar — har kuni yangi va mehr bilan tayyorlanadi.",
  cuisine_ru: 'Одесская',
  cuisine_uz: 'Odessa',
  category_label_ru: 'Ресторан',
  category_label_uz: 'Restoran',
  district_ru: 'Мирабадский район',
  district_uz: 'Mirobod tumani',
  phone: '+998 90 123 45 67',
  address: 'Ташкент, Мирабадский р-н, ул. Шахрисабз, 16',
  address_2gis_url: 'https://2gis.uz/tashkent/search/Одесса%20MA',
  wifi_ssid: 'Guest-WiFi',
  wifi_password: 'welcome2024',
  instagram_url: 'https://instagram.com/odessama_demo',
  telegram_url: 'https://t.me/odessama_demo',
  working_hours: 'Пн-Вс: 08:00–02:00',
  email: 'info@odessa-ma.example',
  rating: 4.9,
  review_count: 512,
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.up = async (pgm) => {
  const existing = await pgm.db.select('SELECT id FROM venues WHERE slug = $1', [SLUG]);
  if (existing.length === 0) return;

  await pgm.db.query(
    `UPDATE venues SET
       logo_url = $1, logo_thumb_url = $2, cover_url = $3, cover_thumb_url = $4,
       description_ru = $5, description_uz = $6, cuisine_ru = $7, cuisine_uz = $8,
       category_label_ru = $9, category_label_uz = $10, district_ru = $11, district_uz = $12,
       phone = $13, address = $14, address_2gis_url = $15,
       wifi_ssid = $16, wifi_password = $17, instagram_url = $18, telegram_url = $19,
       working_hours = $20, email = $21, rating = $22, review_count = $23
     WHERE id = $24`,
    [
      PROFILE.logo_url, PROFILE.logo_thumb_url, PROFILE.cover_url, PROFILE.cover_thumb_url,
      PROFILE.description_ru, PROFILE.description_uz, PROFILE.cuisine_ru, PROFILE.cuisine_uz,
      PROFILE.category_label_ru, PROFILE.category_label_uz, PROFILE.district_ru, PROFILE.district_uz,
      PROFILE.phone, PROFILE.address, PROFILE.address_2gis_url,
      PROFILE.wifi_ssid, PROFILE.wifi_password, PROFILE.instagram_url, PROFILE.telegram_url,
      PROFILE.working_hours, PROFILE.email, PROFILE.rating, PROFILE.review_count,
      existing[0].id,
    ]
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.down = async (pgm) => {
  const existing = await pgm.db.select('SELECT id FROM venues WHERE slug = $1', [SLUG]);
  if (existing.length === 0) return;

  await pgm.db.query(
    `UPDATE venues SET
       logo_url = NULL, logo_thumb_url = NULL, cover_url = NULL, cover_thumb_url = NULL,
       description_ru = NULL, description_uz = NULL, cuisine_ru = NULL, cuisine_uz = NULL,
       category_label_ru = NULL, category_label_uz = NULL, district_ru = NULL, district_uz = NULL,
       phone = NULL, address = NULL, address_2gis_url = NULL,
       wifi_ssid = NULL, wifi_password = NULL, instagram_url = NULL, telegram_url = NULL,
       working_hours = NULL, email = NULL, rating = NULL, review_count = NULL
     WHERE id = $1`,
    [existing[0].id]
  );
};
