/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

const SLUG = 'demo';

// Публичное демо-меню на /menu/demo — постоянный фикстур сервиса (не dev-данные из seed/seed.js:
// та скрипта создаёт учётки с паролями в консоли и не должна запускаться в проде). Эта миграция
// выполняется в любом окружении через обычный `npm run migrate`, поэтому ссылка "Посмотреть демо"
// с лендинга работает всегда, включая продакшен без ручного сидирования.
const WORKING_HOURS = {
  mon: '09:00-22:00',
  tue: '09:00-22:00',
  wed: '09:00-22:00',
  thu: '09:00-22:00',
  fri: '09:00-23:00',
  sat: '10:00-23:00',
  sun: '10:00-22:00',
};

const CATEGORIES = [
  { key: 'snacks', nameRu: 'Закуски', nameUz: 'Gazaklar', sortOrder: 1 },
  { key: 'mains', nameRu: 'Основные блюда', nameUz: 'Asosiy taomlar', sortOrder: 2 },
  { key: 'drinks', nameRu: 'Напитки', nameUz: 'Ichimliklar', sortOrder: 3 },
  { key: 'desserts', nameRu: 'Десерты', nameUz: 'Shirinliklar', sortOrder: 4 },
];

const ITEMS = [
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

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.up = async (pgm) => {
  const existing = await pgm.db.select('SELECT id FROM venues WHERE slug = $1', [SLUG]);
  if (existing.length > 0) {
    return;
  }

  const [venue] = await pgm.db.select(
    `INSERT INTO venues (slug, name, working_hours, lang_default, is_active, show_powered_by)
     VALUES ($1, $2, $3, 'ru', true, true)
     RETURNING id`,
    [SLUG, 'Чайхана «Навруз»', JSON.stringify(WORKING_HOURS)]
  );

  const categoryIds = {};
  for (const category of CATEGORIES) {
    const [row] = await pgm.db.select(
      'INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [venue.id, category.nameRu, category.nameUz, category.sortOrder]
    );
    categoryIds[category.key] = row.id;
  }

  for (const item of ITEMS) {
    await pgm.db.query(
      `INSERT INTO items (category_id, name_ru, name_uz, description_ru, description_uz,
                           composition_ru, composition_uz, calories, price, currency, tags, is_available, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        categoryIds[item.category],
        item.nameRu, item.nameUz,
        item.descriptionRu, item.descriptionUz,
        item.compositionRu, item.compositionUz,
        item.calories,
        item.price, item.currency,
        item.tags,
        item.isAvailable === false ? false : true,
        item.sortOrder,
      ]
    );
  }
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
  const venueId = existing[0].id;
  // venue_id/category_id — RESTRICT, поэтому удаляем снизу вверх: позиции, категории, заведение.
  await pgm.db.query(
    'DELETE FROM items WHERE category_id IN (SELECT id FROM categories WHERE venue_id = $1)',
    [venueId]
  );
  await pgm.db.query('DELETE FROM categories WHERE venue_id = $1', [venueId]);
  await pgm.db.query('DELETE FROM venues WHERE id = $1', [venueId]);
};
