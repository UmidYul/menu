const { pool } = require('../config/db');

const GROUP_FIELDS = 'id, item_id, name_ru, name_uz, name_en, selection, is_required, min_select, max_select, sort_order';
const OPTION_FIELDS = 'id, group_id, name_ru, name_uz, name_en, price_delta, is_available, is_default, sort_order';

// Плоские строки "группа × вариант" → вложенная структура [{...группа, options: [...]}].
// LEFT JOIN — группа без вариантов тоже должна доехать (её ещё наполняют).
function nestRows(rows) {
  const groups = [];
  const byGroupId = new Map();
  for (const row of rows) {
    if (!byGroupId.has(row.group_id)) {
      const group = {
        id: row.group_id,
        item_id: row.item_id,
        name_ru: row.group_name_ru,
        name_uz: row.group_name_uz,
        name_en: row.group_name_en,
        selection: row.selection,
        is_required: row.is_required,
        min_select: row.min_select,
        max_select: row.max_select,
        sort_order: row.group_sort_order,
        options: [],
      };
      byGroupId.set(row.group_id, group);
      groups.push(group);
    }
    if (row.option_id !== null) {
      byGroupId.get(row.group_id).options.push({
        id: row.option_id,
        group_id: row.group_id,
        name_ru: row.option_name_ru,
        name_uz: row.option_name_uz,
        name_en: row.option_name_en,
        price_delta: Number(row.price_delta),
        is_available: row.is_available,
        is_default: row.is_default,
        sort_order: row.option_sort_order,
      });
    }
  }
  return groups;
}

const NESTED_SELECT = `
  SELECT g.id AS group_id, g.item_id,
         g.name_ru AS group_name_ru, g.name_uz AS group_name_uz, g.name_en AS group_name_en,
         g.selection, g.is_required, g.min_select, g.max_select, g.sort_order AS group_sort_order,
         o.id AS option_id, o.name_ru AS option_name_ru, o.name_uz AS option_name_uz, o.name_en AS option_name_en,
         o.price_delta, o.is_available, o.is_default, o.sort_order AS option_sort_order
  FROM item_option_groups g
  LEFT JOIN item_options o ON o.group_id = g.id
`;

async function listGroupsForItem(itemId) {
  const result = await pool.query(
    `${NESTED_SELECT} WHERE g.item_id = $1 ORDER BY g.sort_order, g.id, o.sort_order, o.id`,
    [itemId]
  );
  return nestRows(result.rows);
}

// Все группы всех позиций заведения одним запросом — публичная страница рендерит всё меню
// сразу, отдельный запрос на каждую позицию превратился бы в N+1. Возвращает Map по item_id.
async function listGroupsByItemForVenue(venueId) {
  const result = await pool.query(
    `${NESTED_SELECT}
     JOIN items i ON i.id = g.item_id
     JOIN categories c ON c.id = i.category_id
     WHERE c.venue_id = $1
     ORDER BY g.item_id, g.sort_order, g.id, o.sort_order, o.id`,
    [venueId]
  );
  const byItemId = new Map();
  for (const group of nestRows(result.rows)) {
    if (!byItemId.has(group.item_id)) byItemId.set(group.item_id, []);
    byItemId.get(group.item_id).push(group);
  }
  return byItemId;
}

// Группа вместе с venue_id её позиции — venue_id нужен роутам, чтобы убедиться, что
// венью-админ правит группу СВОЕЙ позиции (проверка в SQL, а не только по шаблону).
async function findGroupWithVenue(groupId) {
  const result = await pool.query(
    `SELECT g.id, g.item_id, g.name_ru, g.name_uz, g.name_en, g.selection, g.is_required,
            g.min_select, g.max_select, g.sort_order, c.venue_id
     FROM item_option_groups g
     JOIN items i ON i.id = g.item_id
     JOIN categories c ON c.id = i.category_id
     WHERE g.id = $1`,
    [groupId]
  );
  return result.rows[0] || null;
}

async function findOptionWithVenue(optionId) {
  const result = await pool.query(
    `SELECT o.id, o.group_id, o.name_ru, o.name_uz, o.name_en, o.price_delta, o.is_available,
            o.is_default, o.sort_order, g.item_id, c.venue_id
     FROM item_options o
     JOIN item_option_groups g ON g.id = o.group_id
     JOIN items i ON i.id = g.item_id
     JOIN categories c ON c.id = i.category_id
     WHERE o.id = $1`,
    [optionId]
  );
  return result.rows[0] || null;
}

async function countGroupsForItem(itemId) {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM item_option_groups WHERE item_id = $1', [itemId]);
  return result.rows[0].count;
}

async function countOptionsInGroup(groupId) {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM item_options WHERE group_id = $1', [groupId]);
  return result.rows[0].count;
}

async function createGroup(itemId, { nameRu, nameUz, nameEn, selection, isRequired, minSelect, maxSelect }, client) {
  const executor = client || pool;
  const nextOrder = await executor.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM item_option_groups WHERE item_id = $1',
    [itemId]
  );
  const result = await executor.query(
    `INSERT INTO item_option_groups (item_id, name_ru, name_uz, name_en, selection, is_required, min_select, max_select, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${GROUP_FIELDS}`,
    [
      itemId, nameRu, nameUz, nameEn || null, selection, isRequired, minSelect, maxSelect,
      nextOrder.rows[0].next_order,
    ]
  );
  return result.rows[0];
}

async function updateGroup(id, { nameRu, nameUz, nameEn, selection, isRequired, minSelect, maxSelect }) {
  const result = await pool.query(
    `UPDATE item_option_groups
     SET name_ru = $2, name_uz = $3, name_en = $4, selection = $5, is_required = $6, min_select = $7, max_select = $8
     WHERE id = $1
     RETURNING ${GROUP_FIELDS}`,
    [id, nameRu, nameUz, nameEn || null, selection, isRequired, minSelect, maxSelect]
  );
  return result.rows[0] || null;
}

async function removeGroup(id) {
  await pool.query('DELETE FROM item_option_groups WHERE id = $1', [id]);
}

async function listGroupsPlainForItem(itemId) {
  const result = await pool.query(
    `SELECT ${GROUP_FIELDS} FROM item_option_groups WHERE item_id = $1 ORDER BY sort_order, id`,
    [itemId]
  );
  return result.rows;
}

async function swapGroupOrder(client, groupA, groupB) {
  await client.query('UPDATE item_option_groups SET sort_order = $1 WHERE id = $2', [groupB.sort_order, groupA.id]);
  await client.query('UPDATE item_option_groups SET sort_order = $1 WHERE id = $2', [groupA.sort_order, groupB.id]);
}

async function createOption(groupId, { nameRu, nameUz, nameEn, priceDelta, isAvailable, isDefault }, client) {
  const executor = client || pool;
  const nextOrder = await executor.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM item_options WHERE group_id = $1',
    [groupId]
  );
  const result = await executor.query(
    `INSERT INTO item_options (group_id, name_ru, name_uz, name_en, price_delta, is_available, is_default, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${OPTION_FIELDS}`,
    [
      groupId, nameRu, nameUz, nameEn || null, priceDelta,
      isAvailable === undefined ? true : isAvailable,
      isDefault === undefined ? false : isDefault,
      nextOrder.rows[0].next_order,
    ]
  );
  return result.rows[0];
}

async function updateOption(id, { nameRu, nameUz, nameEn, priceDelta, isAvailable, isDefault }) {
  const result = await pool.query(
    `UPDATE item_options
     SET name_ru = $2, name_uz = $3, name_en = $4, price_delta = $5, is_available = $6, is_default = $7
     WHERE id = $1
     RETURNING ${OPTION_FIELDS}`,
    [id, nameRu, nameUz, nameEn || null, priceDelta, isAvailable, isDefault]
  );
  return result.rows[0] || null;
}

async function removeOption(id) {
  await pool.query('DELETE FROM item_options WHERE id = $1', [id]);
}

// Перетаскивание вариантов (drag & drop в админке) — приходит готовый порядок id.
// Чужие id молча игнорируются: WHERE group_id = $1 не даст переставить вариант чужой группы.
async function reorderOptions(groupId, orderedIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i += 1) {
      await client.query('UPDATE item_options SET sort_order = $1 WHERE id = $2 AND group_id = $3', [
        i + 1, orderedIds[i], groupId,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// "Скопировать группу из другой позиции" / "применить к нескольким позициям" — одна и та же
// операция: клонируем группу вместе с вариантами в каждую из целевых позиций. Проверку
// принадлежности целевых позиций заведению делает вызывающий роут (он же знает venue_id сессии).
async function copyGroupToItems(groupId, targetItemIds) {
  const source = await pool.query(
    `SELECT ${GROUP_FIELDS} FROM item_option_groups WHERE id = $1`,
    [groupId]
  );
  const group = source.rows[0];
  if (!group) return 0;
  const options = await pool.query(
    `SELECT ${OPTION_FIELDS} FROM item_options WHERE group_id = $1 ORDER BY sort_order, id`,
    [groupId]
  );

  const client = await pool.connect();
  let created = 0;
  try {
    await client.query('BEGIN');
    for (const itemId of targetItemIds) {
      const newGroup = await createGroup(itemId, {
        nameRu: group.name_ru,
        nameUz: group.name_uz,
        nameEn: group.name_en,
        selection: group.selection,
        isRequired: group.is_required,
        minSelect: group.min_select,
        maxSelect: group.max_select,
      }, client);
      for (const option of options.rows) {
        await createOption(newGroup.id, {
          nameRu: option.name_ru,
          nameUz: option.name_uz,
          nameEn: option.name_en,
          priceDelta: option.price_delta,
          isAvailable: option.is_available,
          isDefault: option.is_default,
        }, client);
      }
      created += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return created;
}

module.exports = {
  listGroupsForItem,
  listGroupsByItemForVenue,
  listGroupsPlainForItem,
  findGroupWithVenue,
  findOptionWithVenue,
  countGroupsForItem,
  countOptionsInGroup,
  createGroup,
  updateGroup,
  removeGroup,
  swapGroupOrder,
  createOption,
  updateOption,
  removeOption,
  reorderOptions,
  copyGroupToItems,
};
