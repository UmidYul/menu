const { pool } = require('../config/db');

async function listByVenueGrouped(venueId) {
  const result = await pool.query(
    `SELECT i.id, i.category_id, i.name_ru, i.name_uz, i.name_en,
            i.description_ru, i.description_uz, i.description_en,
            i.composition_ru, i.composition_uz, i.composition_en, i.calories,
            i.price, i.old_price, i.currency, i.photo_url, i.photo_thumb_url, i.tags, i.is_available, i.sort_order,
            i.is_demo, i.weight_value, i.weight_unit, i.cooking_time_minutes, i.allergens, i.spicy_level, i.is_popular,
            c.name_ru AS category_name_ru, c.name_uz AS category_name_uz, c.name_en AS category_name_en,
            c.sort_order AS category_sort_order,
            c.schedule_hidden_mode AS category_schedule_hidden_mode
     FROM items i
     JOIN categories c ON c.id = i.category_id
     WHERE c.venue_id = $1
     ORDER BY c.sort_order, c.id, i.sort_order, i.id`,
    [venueId]
  );
  return result.rows;
}

// Позиции одной категории — для публичной страницы меню, теперь рендерящей одну категорию
// на отдельном URL, а не все категории сразу на одной странице.
async function listByCategory(categoryId) {
  const result = await pool.query(
    `SELECT id, category_id, name_ru, name_uz, name_en, description_ru, description_uz, description_en,
            composition_ru, composition_uz, composition_en, calories,
            price, old_price, currency, photo_url, photo_thumb_url, tags, is_available, sort_order,
            weight_value, weight_unit, cooking_time_minutes, allergens, spicy_level, is_popular
     FROM items
     WHERE category_id = $1
     ORDER BY sort_order, id`,
    [categoryId]
  );
  return result.rows;
}

// Последние добавленные позиции заведения (по id DESC — у items нет created_at),
// для карточки "Последние позиции" в кабинете.
async function listRecentByVenue(venueId, limit) {
  const result = await pool.query(
    `SELECT i.id, i.name_ru, i.name_uz, i.name_en, i.price, i.currency, i.photo_thumb_url, i.is_available,
            c.name_ru AS category_name_ru, c.name_uz AS category_name_uz, c.name_en AS category_name_en
     FROM items i
     JOIN categories c ON c.id = i.category_id
     WHERE c.venue_id = $1
     ORDER BY i.id DESC
     LIMIT $2`,
    [venueId, limit]
  );
  return result.rows;
}

// Группирует плоский список позиций (из listByVenueGrouped) по категории,
// сохраняя порядок категорий и позиций внутри них.
function groupByCategory(items) {
  const groups = [];
  const byCategoryId = new Map();
  for (const item of items) {
    if (!byCategoryId.has(item.category_id)) {
      const group = {
        categoryId: item.category_id,
        categoryName: item.category_name_ru,
        categoryNameRu: item.category_name_ru,
        categoryNameUz: item.category_name_uz,
        categoryNameEn: item.category_name_en,
        // Промт 2.3: режим показа того, что сейчас вне расписания, — настройка категории,
        // позиции своего режима не имеют и наследуют этот.
        scheduleHiddenMode: item.category_schedule_hidden_mode || 'dim',
        items: [],
      };
      byCategoryId.set(item.category_id, group);
      groups.push(group);
    }
    byCategoryId.get(item.category_id).items.push(item);
  }
  return groups;
}

async function findById(id) {
  const result = await pool.query(
    `SELECT i.*, c.venue_id AS category_venue_id
     FROM items i
     JOIN categories c ON c.id = i.category_id
     WHERE i.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function categoryBelongsToVenue(categoryId, venueId) {
  const result = await pool.query('SELECT id FROM categories WHERE id = $1 AND venue_id = $2', [categoryId, venueId]);
  return result.rows.length > 0;
}

async function create({
  categoryId,
  nameRu,
  nameUz,
  nameEn,
  descriptionRu,
  descriptionUz,
  descriptionEn,
  compositionRu,
  compositionUz,
  compositionEn,
  calories,
  price,
  oldPrice,
  currency,
  tags,
  photoUrl,
  photoThumbUrl,
  isDemo,
  weightValue,
  weightUnit,
  cookingTimeMinutes,
  allergens,
  spicyLevel,
  isPopular,
}, client) {
  const executor = client || pool;
  const nextOrderResult = await executor.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM items WHERE category_id = $1',
    [categoryId]
  );
  const sortOrder = nextOrderResult.rows[0].next_order;

  const result = await executor.query(
    `INSERT INTO items (category_id, name_ru, name_uz, name_en, description_ru, description_uz, description_en,
                         composition_ru, composition_uz, composition_en, calories, price, old_price, currency, tags,
                         photo_url, photo_thumb_url, sort_order, is_demo,
                         weight_value, weight_unit, cooking_time_minutes, allergens, spicy_level, is_popular)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
             $20, $21, $22, $23, $24, $25)
     RETURNING *`,
    [
      categoryId, nameRu, nameUz, nameEn || null, descriptionRu, descriptionUz, descriptionEn || null,
      compositionRu || null, compositionUz || null, compositionEn || null,
      calories === undefined ? null : calories, price, oldPrice === undefined ? null : oldPrice, currency, tags,
      photoUrl || null, photoThumbUrl || null, sortOrder, Boolean(isDemo),
      weightValue === undefined ? null : weightValue,
      weightUnit === undefined ? null : weightUnit,
      cookingTimeMinutes === undefined ? null : cookingTimeMinutes,
      allergens || [],
      spicyLevel === undefined ? null : spicyLevel,
      Boolean(isPopular),
    ]
  );
  return result.rows[0];
}

// Промт 1.6 — часть "Удалить примеры", вызывается до removeDemoCategories (FK category_id
// в items — ON DELETE RESTRICT, категорию с чужими позициями не удалить).
async function removeDemoItems(client, venueId) {
  const executor = client || pool;
  await executor.query(
    'DELETE FROM items WHERE is_demo = true AND category_id IN (SELECT id FROM categories WHERE venue_id = $1)',
    [venueId]
  );
}

// Промт 3.6: «каждый запрос к данным обязан фильтровать по activeVenueId В SQL».
//
// venueId ОБЯЗАТЕЛЕН у всех мутаций ниже. Вызывающий код и так проверяет владение через
// loadOwnItemOr404, но проверка отдельным SELECT'ом и мутация по голому id — это два разных
// запроса: между ними сессия может переключиться на другое заведение, а форма — прийти из
// вкладки, открытой в первом. С заведением внутри самого UPDATE такой промах невозможен:
// чужая строка просто не попадёт под условие, и вернётся null.
//
// У items своей venue_id нет — заведение у позиции только через категорию, поэтому условие
// принадлежности везде ниже выражено подзапросом по categories.
//
// photoUrl/photoThumbUrl передаются только когда загружено новое фото — если их нет (null),
// уже сохранённая в БД фотография остаётся без изменений (COALESCE).
async function update(id, venueId, {
  categoryId, nameRu, nameUz, nameEn, descriptionRu, descriptionUz, descriptionEn,
  compositionRu, compositionUz, compositionEn, calories, price, oldPrice, currency, tags, photoUrl, photoThumbUrl,
  weightValue, weightUnit, cookingTimeMinutes, allergens, spicyLevel, isPopular,
}) {
  const result = await pool.query(
    `UPDATE items
     SET category_id = $1, name_ru = $2, name_uz = $3, name_en = $4,
         description_ru = $5, description_uz = $6, description_en = $7,
         composition_ru = $8, composition_uz = $9, composition_en = $10, calories = $11,
         price = $12, old_price = $13, currency = $14, tags = $15,
         photo_url = COALESCE($16, photo_url), photo_thumb_url = COALESCE($17, photo_thumb_url),
         weight_value = $19, weight_unit = $20, cooking_time_minutes = $21,
         allergens = $22, spicy_level = $23, is_popular = $24
     WHERE id = $18
       AND category_id IN (SELECT id FROM categories WHERE venue_id = $25)
       -- И новая категория тоже должна быть своей: иначе UPDATE сам увёл бы позицию
       -- в чужое заведение, оставаясь при этом «своим» по первому условию.
       AND $1 IN (SELECT id FROM categories WHERE venue_id = $25)
     RETURNING *`,
    [
      categoryId, nameRu, nameUz, nameEn || null, descriptionRu, descriptionUz, descriptionEn || null,
      compositionRu || null, compositionUz || null, compositionEn || null,
      calories === undefined ? null : calories, price, oldPrice === undefined ? null : oldPrice, currency, tags,
      photoUrl || null, photoThumbUrl || null, id,
      weightValue === undefined ? null : weightValue,
      weightUnit === undefined ? null : weightUnit,
      cookingTimeMinutes === undefined ? null : cookingTimeMinutes,
      allergens || [],
      spicyLevel === undefined ? null : spicyLevel,
      Boolean(isPopular),
      venueId,
    ]
  );
  return result.rows[0] || null;
}

async function remove(id, venueId) {
  const result = await pool.query(
    `DELETE FROM items
     WHERE id = $1 AND category_id IN (SELECT id FROM categories WHERE venue_id = $2)
     RETURNING id`,
    [id, venueId]
  );
  return result.rows[0] || null;
}

async function toggleAvailability(id, venueId) {
  const result = await pool.query(
    `UPDATE items SET is_available = NOT is_available
     WHERE id = $1 AND category_id IN (SELECT id FROM categories WHERE venue_id = $2)
     RETURNING *`,
    [id, venueId]
  );
  return result.rows[0] || null;
}

module.exports = {
  listByVenueGrouped,
  listByCategory,
  listRecentByVenue,
  groupByCategory,
  findById,
  categoryBelongsToVenue,
  create,
  update,
  remove,
  toggleAvailability,
  removeDemoItems,
};
