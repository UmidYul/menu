const { pool } = require('../config/db');
const categoryModel = require('../models/categoryModel');
const itemModel = require('../models/itemModel');

// Контент — не текст интерфейса, а demo-данные конкретного заведения (та же логика, что у
// уже существующего demo-каталога в migrations/data/odesa-menu.json), поэтому не через t().
// Три категории, три позиции в каждой — ровно как в промте 1.6, без фото (тоже по спеке).
const DEMO_MENU = [
  {
    nameRu: 'Завтраки', nameUz: 'Nonushta',
    items: [
      { nameRu: 'Омлет с овощами', nameUz: 'Sabzavotli omlet', descriptionRu: 'Омлет из трёх яиц с болгарским перцем и зеленью', descriptionUz: "Bolgar qalampiri va ko'katli uch tuxumli omlet", price: 18000 },
      { nameRu: 'Сырники со сметаной', nameUz: 'Tvorogli pishiriqlar', descriptionRu: 'Творожные сырники, подаются со сметаной и джемом', descriptionUz: "Smetana va jem bilan tvorogli pishiriqlar", price: 22000 },
      { nameRu: 'Овсяная каша с ягодами', nameUz: 'Rezavorli ovsyanka', descriptionRu: 'Овсянка на молоке с сезонными ягодами и мёдом', descriptionUz: "Mavsumiy rezavorlar va asal bilan sutli ovsyanka", price: 16000 },
    ],
  },
  {
    nameRu: 'Кофе', nameUz: 'Kofe',
    items: [
      { nameRu: 'Капучино', nameUz: 'Kapuchino', descriptionRu: 'Эспрессо с молочной пенкой', descriptionUz: "Sut ko'pigi bilan espresso", price: 20000 },
      { nameRu: 'Латте', nameUz: 'Latte', descriptionRu: 'Эспрессо с большим количеством молока', descriptionUz: "Ko'p sut bilan espresso", price: 22000 },
      { nameRu: 'Американо', nameUz: 'Amerikano', descriptionRu: 'Эспрессо, разбавленный горячей водой', descriptionUz: "Issiq suv bilan suyultirilgan espresso", price: 15000 },
    ],
  },
  {
    nameRu: 'Десерты', nameUz: 'Shirinliklar',
    items: [
      { nameRu: 'Чизкейк', nameUz: 'Chizkeyk', descriptionRu: 'Классический чизкейк на песочной основе', descriptionUz: "Qumli asosdagi klassik chizkeyk", price: 28000 },
      { nameRu: 'Тирамису', nameUz: 'Tiramisu', descriptionRu: 'Итальянский десерт с маскарпоне и кофе', descriptionUz: "Maskarpone va kofe bilan italyan deserti", price: 30000 },
      { nameRu: 'Медовик', nameUz: 'Medovik', descriptionRu: 'Медовый торт со сметанным кремом', descriptionUz: "Smetana kremli asal tort", price: 24000 },
    ],
  },
];

// Промт 1.6 — кнопка "Заполнить примером" в пустом состоянии категорий. Если у заведения уже
// есть хоть одна категория (демо или нет), повторно не заполняет — кнопка и так пропадает
// из UI, как только появляется первая категория, это просто защита от повторного сабмита.
async function fillWithDemoData(venueId) {
  const existing = await categoryModel.listByVenue(venueId);
  if (existing.length > 0) return { created: false };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const categoryData of DEMO_MENU) {
      const category = await categoryModel.create(
        venueId,
        { nameRu: categoryData.nameRu, nameUz: categoryData.nameUz, isDemo: true },
        client
      );
      for (const itemData of categoryData.items) {
        await itemModel.create(
          {
            categoryId: category.id,
            nameRu: itemData.nameRu,
            nameUz: itemData.nameUz,
            descriptionRu: itemData.descriptionRu,
            descriptionUz: itemData.descriptionUz,
            price: itemData.price,
            currency: 'UZS',
            tags: [],
            isDemo: true,
          },
          client
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { created: true };
}

// Позиции удаляются раньше категорий — items.category_id это ON DELETE RESTRICT.
async function removeDemoData(venueId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await itemModel.removeDemoItems(client, venueId);
    await categoryModel.removeDemoCategories(client, venueId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { fillWithDemoData, removeDemoData };
