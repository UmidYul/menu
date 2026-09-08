// Промт 3.6: «КРИТИЧНО: каждый запрос к данным обязан фильтровать по activeVenueId В SQL.
// Пройди по всем существующим моделям и роутам и убедись, что нигде нет запроса без фильтра
// по заведению. Это главный риск задачи».
//
//   node scripts/check-venue-scoped-writes.js
//
// Мутации моделей вызываются НАПРЯМУЮ, в обход роутов. Это принципиально: у роутов есть своя
// проверка владения (loadOwnItemOr404 и её родня), и через них не отличить «фильтр в SQL» от
// «фильтр в предыдущем SELECT». Проверяется именно второй рубеж — тот, который остаётся, когда
// первый промахнулся: между проверкой и записью сессия может переключиться на другое заведение
// сети, а форма прийти из вкладки, открытой в первом.
//
// Каждая мутация проверяется дважды: со СВОИМ заведением (должна сработать) и с ЧУЖИМ
// (не должна, и строка обязана остаться нетронутой). Одной половины мало: запрос, который
// не делает ничего вообще, прошёл бы проверку «чужое отбито».
require('dotenv').config();

const { pool } = require('../src/config/db');
const itemModel = require('../src/models/itemModel');
const categoryModel = require('../src/models/categoryModel');
const itemOptionModel = require('../src/models/itemOptionModel');
const scheduleModel = require('../src/models/availabilityScheduleModel');

const SUFFIX = Date.now().toString(36);
let passed = 0;
let failed = 0;

function report(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}`);
    if (detail) console.error(`       ${detail}`);
  }
}

// Обе половины сразу: «своё меняется» и «чужое не меняется и не трогается».
// read() возвращает состояние строки, по которому видно, применилась мутация или нет.
async function bothWays(label, { own, foreign, read }) {
  const before = await read();

  const foreignResult = await foreign();
  const afterForeign = await read();
  report(
    !foreignResult && JSON.stringify(afterForeign) === JSON.stringify(before),
    `${label}: с чужим venue_id — отказ, строка не изменилась`,
    `вернулось ${JSON.stringify(foreignResult)}; было ${JSON.stringify(before)}, стало ${JSON.stringify(afterForeign)}`
  );

  const ownResult = await own();
  const afterOwn = await read();
  report(
    Boolean(ownResult) && JSON.stringify(afterOwn) !== JSON.stringify(before),
    `${label}: со своим venue_id — сработало`,
    `вернулось ${JSON.stringify(ownResult)}; было ${JSON.stringify(before)}, стало ${JSON.stringify(afterOwn)}`
  );
}

async function makeVenue(label) {
  const venue = await pool.query(
    `INSERT INTO venues (slug, name, lang_default, status, is_active, show_powered_by)
     VALUES ($1, $2, 'ru', 'active', true, true) RETURNING id`,
    [`ws-${label}-${SUFFIX}`, `ЗАПИСЬ-${label}-${SUFFIX}`]
  );
  const venueId = venue.rows[0].id;

  const category = await pool.query(
    `INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $2, 0) RETURNING id`,
    [venueId, `КАТ-${label}-${SUFFIX}`]
  );
  const second = await pool.query(
    `INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $2, 1) RETURNING id`,
    [venueId, `КАТ2-${label}-${SUFFIX}`]
  );
  const item = await pool.query(
    `INSERT INTO items (category_id, name_ru, name_uz, price, currency, sort_order)
     VALUES ($1, $2, $2, 1000, 'UZS', 0) RETURNING id`,
    [category.rows[0].id, `ПОЗ-${label}-${SUFFIX}`]
  );
  const group = await pool.query(
    `INSERT INTO item_option_groups (item_id, name_ru, name_uz, selection, is_required, min_select, max_select, sort_order)
     VALUES ($1, $2, $2, 'single', false, 0, 1, 0) RETURNING id`,
    [item.rows[0].id, `ГР-${label}-${SUFFIX}`]
  );
  const option = await pool.query(
    `INSERT INTO item_options (group_id, name_ru, name_uz, price_delta, sort_order)
     VALUES ($1, $2, $2, 500, 0) RETURNING id`,
    [group.rows[0].id, `ВАР-${label}-${SUFFIX}`]
  );
  const catRule = await pool.query(
    `INSERT INTO availability_schedules (category_id, days, time_from, time_to)
     VALUES ($1, '{1,2,3}', '09:00', '18:00') RETURNING id`,
    [category.rows[0].id]
  );
  const itemRule = await pool.query(
    `INSERT INTO availability_schedules (item_id, days, time_from, time_to)
     VALUES ($1, '{1,2,3}', '09:00', '18:00') RETURNING id`,
    [item.rows[0].id]
  );

  return {
    venueId,
    categoryId: category.rows[0].id,
    secondCategoryId: second.rows[0].id,
    itemId: item.rows[0].id,
    groupId: group.rows[0].id,
    optionId: option.rows[0].id,
    catRuleId: catRule.rows[0].id,
    itemRuleId: itemRule.rows[0].id,
  };
}

async function cleanup(venueIds) {
  await pool.query(`DELETE FROM availability_schedules WHERE category_id IN (SELECT id FROM categories WHERE venue_id = ANY($1))
                    OR item_id IN (SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id = ANY($1))`, [venueIds]);
  await pool.query(`DELETE FROM item_options WHERE group_id IN (
      SELECT g.id FROM item_option_groups g JOIN items i ON i.id = g.item_id
      JOIN categories c ON c.id = i.category_id WHERE c.venue_id = ANY($1))`, [venueIds]);
  await pool.query(`DELETE FROM item_option_groups WHERE item_id IN (
      SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id = ANY($1))`, [venueIds]);
  await pool.query('DELETE FROM items WHERE category_id IN (SELECT id FROM categories WHERE venue_id = ANY($1))', [venueIds]);
  await pool.query('DELETE FROM categories WHERE venue_id = ANY($1)', [venueIds]);
  await pool.query('DELETE FROM venues WHERE id = ANY($1)', [venueIds]);
}

const ITEM_FIELDS = {
  nameRu: 'НОВОЕ', nameUz: 'НОВОЕ', nameEn: null,
  descriptionRu: null, descriptionUz: null, descriptionEn: null,
  compositionRu: null, compositionUz: null, compositionEn: null,
  calories: null, price: 7777, oldPrice: null, currency: 'UZS', tags: [],
  photoUrl: null, photoThumbUrl: null,
  weightValue: null, weightUnit: null, cookingTimeMinutes: null,
  allergens: [], spicyLevel: null, isPopular: false,
};

(async () => {
  console.log('Проверка venue_id в WHERE самих мутаций (модели вызываются напрямую)\n');

  const own = await makeVenue('СВОЁ');
  const foreign = await makeVenue('ЧУЖОЕ');

  try {
    // --- items ---------------------------------------------------------------------------------
    console.log('items:');
    await bothWays('itemModel.update', {
      read: async () => (await pool.query('SELECT name_ru, price FROM items WHERE id = $1', [own.itemId])).rows[0],
      foreign: () => itemModel.update(own.itemId, foreign.venueId, { ...ITEM_FIELDS, categoryId: own.categoryId }),
      own: () => itemModel.update(own.itemId, own.venueId, { ...ITEM_FIELDS, categoryId: own.categoryId }),
    });

    // Отдельно: увести позицию в категорию ЧУЖОГО заведения нельзя даже своим venue_id —
    // иначе UPDATE сам вынес бы её из заведения, оставаясь «своим» по первому условию.
    const moved = await itemModel.update(own.itemId, own.venueId, { ...ITEM_FIELDS, categoryId: foreign.categoryId });
    const afterMove = (await pool.query('SELECT category_id FROM items WHERE id = $1', [own.itemId])).rows[0];
    report(
      !moved && afterMove.category_id === own.categoryId,
      'itemModel.update: нельзя перенести позицию в категорию чужого заведения',
      `вернулось ${JSON.stringify(moved)}, категория ${afterMove.category_id}`
    );
    // А в свою вторую категорию — можно: условие не должно запрещать обычный перенос.
    const movedOwn = await itemModel.update(own.itemId, own.venueId, { ...ITEM_FIELDS, categoryId: own.secondCategoryId });
    report(Boolean(movedOwn) && movedOwn.category_id === own.secondCategoryId,
      'itemModel.update: перенос в свою другую категорию работает');
    await itemModel.update(own.itemId, own.venueId, { ...ITEM_FIELDS, categoryId: own.categoryId });

    await bothWays('itemModel.toggleAvailability', {
      read: async () => (await pool.query('SELECT is_available FROM items WHERE id = $1', [own.itemId])).rows[0],
      foreign: () => itemModel.toggleAvailability(own.itemId, foreign.venueId),
      own: () => itemModel.toggleAvailability(own.itemId, own.venueId),
    });

    // --- categories ----------------------------------------------------------------------------
    console.log('\ncategories:');
    await bothWays('categoryModel.update', {
      read: async () => (await pool.query('SELECT name_ru FROM categories WHERE id = $1', [own.categoryId])).rows[0],
      foreign: () => categoryModel.update(own.categoryId, foreign.venueId, { nameRu: 'ВЗЛОМ', nameUz: 'ВЗЛОМ', nameEn: null, scheduleHiddenMode: 'dim' }),
      own: () => categoryModel.update(own.categoryId, own.venueId, { nameRu: 'СВОЁ-НОВОЕ', nameUz: 'СВОЁ-НОВОЕ', nameEn: null, scheduleHiddenMode: 'dim' }),
    });

    // --- группы опций и варианты ---------------------------------------------------------------
    console.log('\nitem_option_groups / item_options:');
    await bothWays('itemOptionModel.updateGroup', {
      read: async () => (await pool.query('SELECT name_ru, is_required FROM item_option_groups WHERE id = $1', [own.groupId])).rows[0],
      foreign: () => itemOptionModel.updateGroup(own.groupId, foreign.venueId, { nameRu: 'ВЗЛОМ', nameUz: 'ВЗЛОМ', nameEn: null, selection: 'single', isRequired: true, minSelect: 1, maxSelect: 1 }),
      own: () => itemOptionModel.updateGroup(own.groupId, own.venueId, { nameRu: 'ГР-НОВОЕ', nameUz: 'ГР-НОВОЕ', nameEn: null, selection: 'single', isRequired: true, minSelect: 1, maxSelect: 1 }),
    });

    await bothWays('itemOptionModel.updateOption', {
      read: async () => (await pool.query('SELECT name_ru, price_delta FROM item_options WHERE id = $1', [own.optionId])).rows[0],
      foreign: () => itemOptionModel.updateOption(own.optionId, foreign.venueId, { nameRu: 'ВЗЛОМ', nameUz: 'ВЗЛОМ', nameEn: null, priceDelta: 99999, isAvailable: true, isDefault: false }),
      own: () => itemOptionModel.updateOption(own.optionId, own.venueId, { nameRu: 'ВАР-НОВОЕ', nameUz: 'ВАР-НОВОЕ', nameEn: null, priceDelta: 1234, isAvailable: true, isDefault: false }),
    });

    // --- расписания ----------------------------------------------------------------------------
    // Две ветви: правило категории и правило позиции — venue у них достаётся по-разному.
    console.log('\navailability_schedules:');
    await bothWays('scheduleModel.update (правило категории)', {
      read: async () => (await pool.query('SELECT time_from FROM availability_schedules WHERE id = $1', [own.catRuleId])).rows[0],
      foreign: () => scheduleModel.update(own.catRuleId, foreign.venueId, { days: [1, 2], timeFrom: '01:00', timeTo: '02:00' }),
      own: () => scheduleModel.update(own.catRuleId, own.venueId, { days: [1, 2], timeFrom: '10:00', timeTo: '20:00' }),
    });

    await bothWays('scheduleModel.toggleActive (правило позиции)', {
      read: async () => (await pool.query('SELECT is_active FROM availability_schedules WHERE id = $1', [own.itemRuleId])).rows[0],
      foreign: () => scheduleModel.toggleActive(own.itemRuleId, foreign.venueId),
      own: () => scheduleModel.toggleActive(own.itemRuleId, own.venueId),
    });

    // --- удаления ------------------------------------------------------------------------------
    // Удаление проверяется в обратном порядке (сначала чужой venue_id, потом свой) и по счётчику
    // строк: у него «не изменилось» и «изменилось» выражаются наличием самой записи.
    console.log('\nудаления:');
    const exists = async (table, id) => (
      (await pool.query(`SELECT count(*)::int AS c FROM ${table} WHERE id = $1`, [id])).rows[0].c
    );

    const deletions = [
      { label: 'scheduleModel.remove', table: 'availability_schedules', id: own.catRuleId, fn: (v) => scheduleModel.remove(own.catRuleId, v) },
      { label: 'itemOptionModel.removeOption', table: 'item_options', id: own.optionId, fn: (v) => itemOptionModel.removeOption(own.optionId, v) },
      { label: 'itemOptionModel.removeGroup', table: 'item_option_groups', id: own.groupId, fn: (v) => itemOptionModel.removeGroup(own.groupId, v) },
      { label: 'itemModel.remove', table: 'items', id: own.itemId, fn: (v) => itemModel.remove(own.itemId, v) },
    ];

    for (const del of deletions) {
      // eslint-disable-next-line no-await-in-loop
      const deniedResult = await del.fn(foreign.venueId);
      // eslint-disable-next-line no-await-in-loop
      const stillThere = await exists(del.table, del.id);
      report(!deniedResult && stillThere === 1, `${del.label}: с чужим venue_id строка на месте`);

      // eslint-disable-next-line no-await-in-loop
      const okResult = await del.fn(own.venueId);
      // eslint-disable-next-line no-await-in-loop
      const gone = await exists(del.table, del.id);
      report(Boolean(okResult) && gone === 0, `${del.label}: со своим venue_id удалено`);
    }

    // Правило позиции удалилось каскадом вместе с позицией — отдельная проверка не нужна,
    // а вот категорию можно удалить только теперь, когда позиций в ней не осталось.
    const catDenied = await categoryModel.remove(own.categoryId, foreign.venueId);
    const catStill = await exists('categories', own.categoryId);
    report(!catDenied && catStill === 1, 'categoryModel.remove: с чужим venue_id категория на месте');
    const catOk = await categoryModel.remove(own.categoryId, own.venueId);
    const catGone = await exists('categories', own.categoryId);
    report(Boolean(catOk) && catGone === 0, 'categoryModel.remove: со своим venue_id удалено');

    // Данные чужого заведения не пострадали ни разу за весь прогон.
    const foreignIntact = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM categories WHERE venue_id = $1) AS categories,
         (SELECT count(*)::int FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id = $1) AS items,
         (SELECT count(*)::int FROM item_option_groups g JOIN items i ON i.id = g.item_id
            JOIN categories c ON c.id = i.category_id WHERE c.venue_id = $1) AS groups`,
      [foreign.venueId]
    );
    const intact = foreignIntact.rows[0];
    report(
      intact.categories === 2 && intact.items === 1 && intact.groups === 1,
      'чужое заведение целиком нетронуто',
      JSON.stringify(intact)
    );
  } finally {
    await cleanup([own.venueId, foreign.venueId]);
  }

  console.log(`\nпроверок: ${passed + failed}, пройдено: ${passed}, провалов: ${failed}`);
  if (failed > 0) process.exitCode = 1;
  process.exit(process.exitCode || 0);
})().catch(async (err) => {
  console.error('Скрипт упал:', err);
  process.exit(1);
});
