const { pool } = require('../config/db');

// Промт 2.3. Расписания доступности категорий и позиций. Строка всегда ссылается ровно на одну
// сущность (CHECK в миграции), поэтому «полиморфных» ветвлений тут нет — есть два набора
// функций с одинаковой формой.

// Сколько интервалов можно завести на одну сущность. Ограничение не из промта: в схеме его нет,
// но без потолка форма превращается в способ положить рендер меню длинным списком правил.
const MAX_RULES_PER_ENTITY = 10;

const RULE_COLUMNS = 'id, category_id, item_id, days, time_from, time_to, is_active';

// Все расписания заведения одним запросом — так их читает рендер публичного меню, где нужны
// сразу все категории и все позиции. Отдельный запрос на сущность превратил бы одну страницу
// в сотню обращений к БД.
async function listByVenue(venueId) {
  const result = await pool.query(
    `SELECT s.id, s.category_id, s.item_id, s.days, s.time_from, s.time_to, s.is_active
     FROM availability_schedules s
     LEFT JOIN categories c ON c.id = s.category_id
     LEFT JOIN items i ON i.id = s.item_id
     LEFT JOIN categories ic ON ic.id = i.category_id
     WHERE COALESCE(c.venue_id, ic.venue_id) = $1
     ORDER BY s.time_from, s.id`,
    [venueId]
  );
  return result.rows;
}

// Раскладывает плоский список в две Map — по категориям и по позициям. Вызывающему коду
// (publicMenu.js, adminItems.js) удобнее спрашивать «правила этой сущности», а не фильтровать
// общий массив на каждую строку меню.
function groupByEntity(rows) {
  const byCategory = new Map();
  const byItem = new Map();
  rows.forEach((row) => {
    const target = row.category_id ? byCategory : byItem;
    const key = row.category_id || row.item_id;
    if (!target.has(key)) target.set(key, []);
    target.get(key).push(row);
  });
  return { byCategory, byItem };
}

async function listByCategory(categoryId) {
  const result = await pool.query(
    `SELECT ${RULE_COLUMNS} FROM availability_schedules WHERE category_id = $1 ORDER BY time_from, id`,
    [categoryId]
  );
  return result.rows;
}

async function listByItem(itemId) {
  const result = await pool.query(
    `SELECT ${RULE_COLUMNS} FROM availability_schedules WHERE item_id = $1 ORDER BY time_from, id`,
    [itemId]
  );
  return result.rows;
}

async function countForCategory(categoryId) {
  const result = await pool.query(
    'SELECT count(*)::int AS count FROM availability_schedules WHERE category_id = $1',
    [categoryId]
  );
  return result.rows[0].count;
}

async function countForItem(itemId) {
  const result = await pool.query(
    'SELECT count(*)::int AS count FROM availability_schedules WHERE item_id = $1',
    [itemId]
  );
  return result.rows[0].count;
}

async function createForCategory(categoryId, { days, timeFrom, timeTo }) {
  const result = await pool.query(
    `INSERT INTO availability_schedules (category_id, days, time_from, time_to)
     VALUES ($1, $2, $3, $4)
     RETURNING ${RULE_COLUMNS}`,
    [categoryId, days, timeFrom, timeTo]
  );
  return result.rows[0];
}

async function createForItem(itemId, { days, timeFrom, timeTo }) {
  const result = await pool.query(
    `INSERT INTO availability_schedules (item_id, days, time_from, time_to)
     VALUES ($1, $2, $3, $4)
     RETURNING ${RULE_COLUMNS}`,
    [itemId, days, timeFrom, timeTo]
  );
  return result.rows[0];
}

// Правило вместе с venue_id владельца — единственный способ проверить принадлежность,
// не доверяя переданному id. Владение проверяется в SQL, а не в шаблоне (правило проекта):
// у правила категории venue берётся напрямую, у правила позиции — через её категорию.
async function findByIdWithVenue(id) {
  const result = await pool.query(
    `SELECT s.id, s.category_id, s.item_id, s.days, s.time_from, s.time_to, s.is_active,
            COALESCE(c.venue_id, ic.venue_id) AS venue_id
     FROM availability_schedules s
     LEFT JOIN categories c ON c.id = s.category_id
     LEFT JOIN items i ON i.id = s.item_id
     LEFT JOIN categories ic ON ic.id = i.category_id
     WHERE s.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Промт 3.6: venue_id входит в WHERE самих мутаций. У правила своей venue_id нет — оно висит
// либо на категории (venue берётся напрямую), либо на позиции (через её категорию), поэтому
// условие принадлежности проверяет обе ветви сразу. Ровно та же логика, что в findByIdWithVenue
// выше, но применённая к самой записи, а не к предварительной проверке: между проверкой и
// записью сессия может переключиться на другое заведение сети.
//
// Условие расписано в каждом запросе целиком, а не собирается из шаблона: номера плейсхолдеров
// у запросов разные, и подстановка их в общий кусок SQL — как раз тот приём, из-за которого
// потом не видно, какой параметр куда попал.
async function update(id, venueId, { days, timeFrom, timeTo }) {
  const result = await pool.query(
    `UPDATE availability_schedules SET days = $1, time_from = $2, time_to = $3
     WHERE id = $4
       AND (
         category_id IN (SELECT id FROM categories WHERE venue_id = $5)
         OR item_id IN (SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id = $5)
       )
     RETURNING ${RULE_COLUMNS}`,
    [days, timeFrom, timeTo, id, venueId]
  );
  return result.rows[0] || null;
}

async function toggleActive(id, venueId) {
  const result = await pool.query(
    `UPDATE availability_schedules SET is_active = NOT is_active
     WHERE id = $1
       AND (
         category_id IN (SELECT id FROM categories WHERE venue_id = $2)
         OR item_id IN (SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id = $2)
       )
     RETURNING ${RULE_COLUMNS}`,
    [id, venueId]
  );
  return result.rows[0] || null;
}

async function remove(id, venueId) {
  const result = await pool.query(
    `DELETE FROM availability_schedules
     WHERE id = $1
       AND (
         category_id IN (SELECT id FROM categories WHERE venue_id = $2)
         OR item_id IN (SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id = $2)
       )
     RETURNING id`,
    [id, venueId]
  );
  return result.rows[0] || null;
}

// «Доступно всегда» в форме — это отсутствие правил, а не отдельный флаг: одно состояние
// вместо двух, которые могли бы разойтись.
async function removeAllForCategory(categoryId, venueId) {
  const result = await pool.query(
    `DELETE FROM availability_schedules
     WHERE category_id = $1 AND category_id IN (SELECT id FROM categories WHERE venue_id = $2)
     RETURNING id`,
    [categoryId, venueId]
  );
  return result.rowCount;
}

async function removeAllForItem(itemId, venueId) {
  const result = await pool.query(
    `DELETE FROM availability_schedules
     WHERE item_id = $1 AND item_id IN (
       SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id = $2
     )
     RETURNING id`,
    [itemId, venueId]
  );
  return result.rowCount;
}

module.exports = {
  MAX_RULES_PER_ENTITY,
  listByVenue,
  groupByEntity,
  listByCategory,
  listByItem,
  countForCategory,
  countForItem,
  createForCategory,
  createForItem,
  findByIdWithVenue,
  update,
  toggleActive,
  remove,
  removeAllForCategory,
  removeAllForItem,
};
