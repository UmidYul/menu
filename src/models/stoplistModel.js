const { pool } = require('../config/db');

// Промт 3.5. Данные экрана стоп-листа и переключатели, которыми пользуется официант.
//
// Отдельная модель, а не пара функций в itemModel: у стоп-листа своя выборка (позиции вместе
// с вариантами опций и с тем, кто последний раз их трогал) и свои venue-scoped мутации, где
// venue_id входит в WHERE самого UPDATE. Это принципиально: официант не должен уметь
// переключить позицию чужого заведения, подставив её id, и защищать это должен SQL, а не шаблон.

// «Кто и когда последний раз менял позицию» берётся из журнала действий, а не из отдельной
// колонки в items: журнал уже пишется на каждое переключение (logAction), и дублировать те же
// сведения в items значило бы завести второй источник правды, который однажды разойдётся.
// DISTINCT ON — последняя запись на сущность; сортировка внутри обязана совпадать с DISTINCT ON.
const LAST_TOGGLE_CTE = `
  last_toggle AS (
    SELECT DISTINCT ON (l.entity_id)
           l.entity_id, l.created_at, l.details,
           COALESCE(a.display_name, a.login) AS actor_name
    FROM admin_action_logs l
    LEFT JOIN admins a ON a.id = l.admin_id
    WHERE l.venue_id = $1 AND l.entity_type = 'item' AND l.action_type = 'toggle_availability'
    ORDER BY l.entity_id, l.created_at DESC
  )`;

// Всё меню заведения одним запросом. Позиции — включая недоступные (в этом и смысл экрана)
// и включая демо: официант видит ровно то, что видит гость.
async function listItems(venueId) {
  const result = await pool.query(
    `WITH ${LAST_TOGGLE_CTE}
     SELECT i.id, i.category_id, i.name_ru, i.name_uz, i.name_en,
            i.price, i.currency, i.photo_thumb_url, i.is_available,
            c.name_ru AS category_name_ru, c.name_uz AS category_name_uz, c.name_en AS category_name_en,
            t.created_at AS last_toggle_at,
            t.actor_name AS last_toggle_by,
            (t.details ->> 'is_available')::boolean AS last_toggle_value
     FROM items i
     JOIN categories c ON c.id = i.category_id
     LEFT JOIN last_toggle t ON t.entity_id = i.id
     WHERE c.venue_id = $1
     ORDER BY c.sort_order, c.id, i.sort_order, i.id`,
    [venueId]
  );
  return result.rows;
}

// Варианты опций всех позиций заведения — плоским списком, группировку делает вызывающий код.
// Промт разрешает staff переключать доступность варианта, но не трогать его цену и название,
// поэтому наружу отдаём только то, что нужно нарисовать строку.
async function listOptions(venueId) {
  const result = await pool.query(
    `SELECT o.id, o.name_ru, o.name_uz, o.name_en, o.is_available,
            g.id AS group_id, g.name_ru AS group_name_ru, g.name_uz AS group_name_uz, g.name_en AS group_name_en,
            g.item_id
     FROM item_options o
     JOIN item_option_groups g ON g.id = o.group_id
     JOIN items i ON i.id = g.item_id
     JOIN categories c ON c.id = i.category_id
     WHERE c.venue_id = $1
     ORDER BY g.item_id, g.sort_order, g.id, o.sort_order, o.id`,
    [venueId]
  );
  return result.rows;
}

// Лёгкая выборка только состояний — для сверки, когда вкладка официанта возвращается на
// передний план после того, как телефон полежал в кармане (промт: интерфейс подтягивает
// актуальное состояние, конфликт не должен приводить к ошибке).
async function listStates(venueId) {
  const [items, options] = await Promise.all([
    pool.query(
      `SELECT i.id, i.is_available FROM items i
       JOIN categories c ON c.id = i.category_id WHERE c.venue_id = $1`,
      [venueId]
    ),
    pool.query(
      `SELECT o.id, o.is_available FROM item_options o
       JOIN item_option_groups g ON g.id = o.group_id
       JOIN items i ON i.id = g.item_id
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $1`,
      [venueId]
    ),
  ]);
  return { items: items.rows, options: options.rows };
}

// venue_id — в WHERE самого UPDATE, а не отдельной проверкой перед ним: так чужая позиция
// не переключится ни при гонке, ни при подставленном id, и функция вернёт null.
// RETURNING отдаёт ФАКТИЧЕСКОЕ состояние после переключения — именно его рисует клиент вместо
// своей оптимистичной догадки, поэтому двое официантов на одной позиции получают «последний
// выигрывает», а не ошибку (edge case промта).
async function toggleItem(itemId, venueId) {
  const result = await pool.query(
    `UPDATE items SET is_available = NOT is_available
     WHERE id = $1 AND category_id IN (SELECT id FROM categories WHERE venue_id = $2)
     RETURNING id, name_ru, name_uz, name_en, is_available`,
    [itemId, venueId]
  );
  return result.rows[0] || null;
}

async function toggleOption(optionId, venueId) {
  const result = await pool.query(
    `UPDATE item_options SET is_available = NOT is_available
     WHERE id = $1 AND group_id IN (
       SELECT g.id FROM item_option_groups g
       JOIN items i ON i.id = g.item_id
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $2
     )
     RETURNING id, group_id, name_ru, name_uz, name_en, is_available`,
    [optionId, venueId]
  );
  return result.rows[0] || null;
}

// «Вернуть всё в наличие» — типичное утреннее действие. Возвращает только реально изменённые
// строки: если всё и так в наличии, нечего писать в журнал и незачем сбрасывать кэш меню.
async function restoreAll(venueId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const items = await client.query(
      `UPDATE items SET is_available = true
       WHERE is_available = false AND category_id IN (SELECT id FROM categories WHERE venue_id = $1)
       RETURNING id`,
      [venueId]
    );
    const options = await client.query(
      `UPDATE item_options SET is_available = true
       WHERE is_available = false AND group_id IN (
         SELECT g.id FROM item_option_groups g
         JOIN items i ON i.id = g.item_id
         JOIN categories c ON c.id = i.category_id
         WHERE c.venue_id = $1
       )
       RETURNING id`,
      [venueId]
    );
    await client.query('COMMIT');
    return { itemIds: items.rows.map((row) => row.id), optionIds: options.rows.map((row) => row.id) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listItems,
  listOptions,
  listStates,
  toggleItem,
  toggleOption,
  restoreAll,
};
