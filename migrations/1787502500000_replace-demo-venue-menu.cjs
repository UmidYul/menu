/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

const path = require('path');

const SLUG = 'demo';
const NEW_VENUE_NAME = 'Одесса MA';
const OLD_VENUE_NAME = 'Чайхана «Навруз»';
// Условный (не привязанный к реальному заведению) wifi для демонстрации соответствующего
// блока в шапке и в info-blocks на публичной странице меню.
const NEW_WIFI_SSID = 'Guest-WiFi';
const NEW_WIFI_PASSWORD = 'welcome2024';

// Реальный каталог одесской кухни (16 категорий, 90 позиций с фото) — заменяет собой
// плейсхолдер-меню чайханы "Навруз" из 1787502000000_seed-demo-venue.cjs. Фото — прямые
// ссылки на storage.ma-emirates.com (сторонний CDN исходного поставщика данных).
const { categories: NEW_CATEGORIES, items: NEW_ITEMS } = require(path.join(__dirname, 'data', 'odesa-menu.json'));

// Прежнее содержимое demo (см. 1787502000000_seed-demo-venue.cjs) — нужно для down(),
// чтобы миграцию можно было безопасно откатить.
const OLD_CATEGORIES = [
  { key: 'snacks', nameRu: 'Закуски', nameUz: 'Gazaklar', sortOrder: 1 },
  { key: 'mains', nameRu: 'Основные блюда', nameUz: 'Asosiy taomlar', sortOrder: 2 },
  { key: 'drinks', nameRu: 'Напитки', nameUz: 'Ichimliklar', sortOrder: 3 },
  { key: 'desserts', nameRu: 'Десерты', nameUz: 'Shirinliklar', sortOrder: 4 },
];

const OLD_ITEMS = [
  {
    category: 'snacks',
    nameRu: 'Самса тандырная', nameUz: 'Tandir somsasi',
    descriptionRu: 'Слоёное тесто с сочной бараниной и луком', descriptionUz: "Qatlamli xamir, mo'l qo'y go'shti va piyoz bilan",
    compositionRu: 'тесто, баранина, лук, специи', compositionUz: "xamir, qo'y go'shti, piyoz, ziravorlar",
    calories: 320, price: 16000, currency: 'UZS', tags: ['halal'], sortOrder: 1,
  },
  {
    category: 'snacks',
    nameRu: 'Чучвара', nameUz: 'Chuchvara',
    descriptionRu: 'Домашние пельмени с мясом, сметаной и зеленью', descriptionUz: "Go'sht, smetana va ko'katli uy chuchvarasi",
    compositionRu: 'тесто, говядина, сметана, зелень', compositionUz: "xamir, mol go'shti, smetana, ko'katlar",
    calories: 280, price: 28000, currency: 'UZS', tags: ['halal'], sortOrder: 2,
  },
  {
    category: 'mains',
    nameRu: 'Плов Ташкентский', nameUz: 'Toshkent oshi',
    descriptionRu: 'Рис девзира, говядина, морковь и нут', descriptionUz: "Devzira guruch, mol go'shti, sabzi va no'xat",
    compositionRu: 'рис, говядина, морковь, нут, масло', compositionUz: "guruch, mol go'shti, sabzi, no'xat, moy",
    calories: 410, price: 42000, currency: 'UZS', tags: ['halal', 'new'], sortOrder: 1,
  },
  {
    category: 'mains',
    nameRu: 'Лагман', nameUz: 'Lagmon',
    descriptionRu: 'Тянутая лапша с мясом, овощами и ароматным бульоном', descriptionUz: "Go'sht, sabzavot va xushbo'y sho'rvali cho'zma lag'mon",
    compositionRu: 'лапша, говядина, перец, томаты, специи', compositionUz: "lag'mon, mol go'shti, qalampir, pomidor, ziravorlar",
    calories: 380, price: 35000, currency: 'UZS', tags: ['halal', 'spicy'], sortOrder: 2,
  },
  {
    category: 'mains',
    nameRu: 'Салат овощной', nameUz: 'Sabzavotli salat',
    descriptionRu: 'Свежие сезонные овощи с зеленью', descriptionUz: "Ko'katli yangi mavsumiy sabzavotlar",
    compositionRu: 'огурцы, помидоры, зелень, оливковое масло', compositionUz: "bodring, pomidor, ko'katlar, zaytun moyi",
    calories: 120, price: 20000, currency: 'UZS', tags: ['vegan', 'vegetarian'], sortOrder: 3, isAvailable: false,
  },
  {
    category: 'drinks',
    nameRu: 'Капучино', nameUz: 'Kapuchino',
    descriptionRu: 'Классический капучино на молоке', descriptionUz: 'Sutli klassik kapuchino',
    compositionRu: null, compositionUz: null,
    calories: null, price: 25000, currency: 'UZS', tags: ['vegetarian'], sortOrder: 1,
  },
  {
    category: 'drinks',
    nameRu: 'Компот из сухофруктов', nameUz: 'Quritilgan mevalardan kompot',
    descriptionRu: 'Домашний компот без сахара', descriptionUz: "Shakarsiz uy kompoti",
    compositionRu: 'сухофрукты, вода', compositionUz: "quritilgan mevalar, suv",
    calories: 90, price: 15000, currency: 'UZS', tags: ['vegan', 'new'], sortOrder: 2,
  },
  {
    category: 'desserts',
    nameRu: 'Пахлава', nameUz: 'Pahlava',
    descriptionRu: 'Слоёная выпечка с орехами и мёдом', descriptionUz: "Yong'oq va asal bilan qatlamli shirinlik",
    compositionRu: 'тесто, орехи, мёд, масло', compositionUz: "xamir, yong'oq, asal, moy",
    calories: 340, price: 18000, currency: 'UZS', tags: ['vegetarian'], sortOrder: 1,
  },
];

async function replaceMenu(pgm, venueId, categories, items) {
  await pgm.db.query(
    'DELETE FROM items WHERE category_id IN (SELECT id FROM categories WHERE venue_id = $1)',
    [venueId]
  );
  await pgm.db.query('DELETE FROM categories WHERE venue_id = $1', [venueId]);

  const categoryIds = {};
  for (const category of categories) {
    const [row] = await pgm.db.select(
      'INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [venueId, category.nameRu, category.nameUz, category.sortOrder]
    );
    categoryIds[category.key] = row.id;
  }

  for (const item of items) {
    await pgm.db.query(
      `INSERT INTO items (category_id, name_ru, name_uz, description_ru, description_uz,
                           composition_ru, composition_uz, calories, price, old_price, currency, tags,
                           photo_url, photo_thumb_url, is_available, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        categoryIds[item.category],
        item.nameRu, item.nameUz,
        item.descriptionRu, item.descriptionUz,
        item.compositionRu, item.compositionUz,
        item.calories === undefined ? null : item.calories,
        item.price,
        item.oldPrice === undefined ? null : item.oldPrice,
        item.currency,
        item.tags || [],
        item.photoUrl || null,
        item.photoThumbUrl || null,
        item.isAvailable === false ? false : true,
        item.sortOrder,
      ]
    );
  }
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.up = async (pgm) => {
  const existing = await pgm.db.select('SELECT id FROM venues WHERE slug = $1', [SLUG]);
  if (existing.length === 0) {
    return;
  }
  await pgm.db.query(
    'UPDATE venues SET name = $1, wifi_ssid = $2, wifi_password = $3 WHERE id = $4',
    [NEW_VENUE_NAME, NEW_WIFI_SSID, NEW_WIFI_PASSWORD, existing[0].id]
  );
  await replaceMenu(pgm, existing[0].id, NEW_CATEGORIES, NEW_ITEMS);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.down = async (pgm) => {
  const existing = await pgm.db.select('SELECT id FROM venues WHERE slug = $1', [SLUG]);
  if (existing.length === 0) {
    return;
  }
  await pgm.db.query(
    'UPDATE venues SET name = $1, wifi_ssid = NULL, wifi_password = NULL WHERE id = $2',
    [OLD_VENUE_NAME, existing[0].id]
  );
  await replaceMenu(pgm, existing[0].id, OLD_CATEGORIES, OLD_ITEMS);
};
