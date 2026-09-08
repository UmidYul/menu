const { pool } = require('../config/db');
const photoService = require('./photoService');
const { logAction } = require('../models/adminActionLogModel');

// Промт 3.6, раздел 5: «Скопировать меню из другого заведения» с выбором источника и опциями:
// копировать фото или нет, копировать цены или обнулить. Выполняется в транзакции,
// с предпросмотром количества категорий и позиций.
//
// Копирование ДОБАВЛЯЕТ, а не замещает: существующее меню остаётся на месте. Замещение здесь
// было бы необратимой операцией с необратимыми последствиями (одно неверное нажатие — и меню
// работающего заведения стёрто), и промт его не просит.
//
// Вместе с позициями копируются группы опций и варианты внутри них. Отдельного вопроса про них
// нет намеренно: позиция с обязательным выбором размера, приехавшая без самих размеров, — это
// не «упрощённая копия», а сломанное блюдо, которое нельзя заказать.
// Расписания доступности (промт 2.3) НЕ копируются: они привязаны к часам работы конкретной
// точки, и переносить «до 12:00» из одного заведения в другое — почти наверняка ошибка.

// Что будет скопировано — до того, как что-либо изменится. Считает по тем же условиям,
// по которым потом идёт выборка, иначе предпросмотр обещал бы не то, что происходит.
async function preview(sourceVenueId) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM categories WHERE venue_id = $1) AS categories,
       (SELECT count(*)::int FROM items i
          JOIN categories c ON c.id = i.category_id
         WHERE c.venue_id = $1) AS items`,
    [sourceVenueId]
  );
  return result.rows[0];
}

// Читается всё меню источника ДО открытия транзакции: держать транзакцию открытой на время
// чтения нечего, а на время копирования файлов — тем более.
async function readSourceMenu(sourceVenueId) {
  const [categories, items, groups, options] = await Promise.all([
    pool.query(
      `SELECT id, name_ru, name_uz, name_en, sort_order, schedule_hidden_mode
       FROM categories WHERE venue_id = $1 ORDER BY sort_order, id`,
      [sourceVenueId]
    ),
    pool.query(
      `SELECT i.id, i.category_id, i.name_ru, i.name_uz, i.name_en,
              i.description_ru, i.description_uz, i.description_en,
              i.composition_ru, i.composition_uz, i.composition_en,
              i.price, i.old_price, i.currency, i.photo_url, i.photo_thumb_url,
              i.tags, i.allergens, i.is_available, i.sort_order, i.calories,
              i.weight_value, i.weight_unit, i.cooking_time_minutes, i.spicy_level, i.is_popular
       FROM items i
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $1
       ORDER BY i.sort_order, i.id`,
      [sourceVenueId]
    ),
    pool.query(
      `SELECT g.id, g.item_id, g.name_ru, g.name_uz, g.name_en,
              g.selection, g.is_required, g.min_select, g.max_select, g.sort_order
       FROM item_option_groups g
       JOIN items i ON i.id = g.item_id
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $1
       ORDER BY g.sort_order, g.id`,
      [sourceVenueId]
    ),
    pool.query(
      `SELECT o.id, o.group_id, o.name_ru, o.name_uz, o.name_en,
              o.price_delta, o.is_available, o.is_default, o.sort_order
       FROM item_options o
       JOIN item_option_groups g ON g.id = o.group_id
       JOIN items i ON i.id = g.item_id
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $1
       ORDER BY o.sort_order, o.id`,
      [sourceVenueId]
    ),
  ]);

  return {
    categories: categories.rows,
    items: items.rows,
    groups: groups.rows,
    options: options.rows,
  };
}

// Копирует меню sourceVenueId в targetVenueId. Возвращает { categories, items } — сколько
// строк реально создано.
//
// Порядок операций выбран так, чтобы отказ на любом шаге не оставлял мусора:
// файлы копируются ДО транзакции (их пути запоминаются), строки пишутся В транзакции,
// и если транзакция откатилась — скопированные файлы удаляются. Обратный порядок (сначала
// строки, потом файлы) оставил бы в БД позиции со ссылками на ещё не существующие картинки.
async function copyMenu({
  sourceVenueId, targetVenueId, withPhotos, withPrices, actorAdminId,
}) {
  const source = await readSourceMenu(sourceVenueId);
  if (source.items.length === 0) {
    const error = new Error('COPY_SOURCE_EMPTY');
    throw error;
  }

  // Скопированные файлы — чтобы удалить их при откате.
  const copiedFiles = [];
  // id исходной позиции -> новые URL её фото.
  const photosByItemId = new Map();

  if (withPhotos) {
    // Последовательно, а не Promise.all: меню на несколько сотен позиций открыло бы разом
    // тысячу файловых дескрипторов.
    for (const item of source.items) {
      if (!item.photo_url && !item.photo_thumb_url) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const copied = await photoService.copyItemPhotoFiles(targetVenueId, item.photo_url, item.photo_thumb_url);
        if (copied) {
          copiedFiles.push(...copied.files);
          photosByItemId.set(item.id, copied);
        }
      } catch (err) {
        await photoService.deleteFiles(copiedFiles);
        throw err;
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Новые категории дописываются ПОСЛЕ существующих: sort_order источника начинается с нуля
    // и, использованный как есть, перемешал бы копию с уже имеющимся меню.
    const maxSort = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS max FROM categories WHERE venue_id = $1',
      [targetVenueId]
    );
    const sortOffset = Number(maxSort.rows[0].max) + 1;

    const categoryIdMap = new Map();
    for (const category of source.categories) {
      // eslint-disable-next-line no-await-in-loop
      const created = await client.query(
        `INSERT INTO categories (venue_id, name_ru, name_uz, name_en, sort_order, schedule_hidden_mode)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          targetVenueId, category.name_ru, category.name_uz, category.name_en,
          sortOffset + category.sort_order, category.schedule_hidden_mode,
        ]
      );
      categoryIdMap.set(category.id, created.rows[0].id);
    }

    const itemIdMap = new Map();
    for (const item of source.items) {
      const newCategoryId = categoryIdMap.get(item.category_id);
      // Позиция без скопированной категории — невозможное состояние (обе выборки шли по одному
      // venue_id), но вставлять её в чужую категорию мы точно не станем.
      if (!newCategoryId) continue;

      const photo = photosByItemId.get(item.id);
      // eslint-disable-next-line no-await-in-loop
      const created = await client.query(
        `INSERT INTO items (
           category_id, name_ru, name_uz, name_en,
           description_ru, description_uz, description_en,
           composition_ru, composition_uz, composition_en,
           price, old_price, currency, photo_url, photo_thumb_url,
           tags, allergens, is_available, sort_order, calories,
           weight_value, weight_unit, cooking_time_minutes, spicy_level, is_popular
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, $23, $24, $25
         ) RETURNING id`,
        [
          newCategoryId, item.name_ru, item.name_uz, item.name_en,
          item.description_ru, item.description_uz, item.description_en,
          item.composition_ru, item.composition_uz, item.composition_en,
          // «Копировать цены или обнулить»: при обнулении старая цена (перечёркнутая) тоже
          // теряет смысл — она существует только относительно текущей.
          withPrices ? item.price : 0,
          withPrices ? item.old_price : null,
          item.currency, photo ? photo.photoUrl : null, photo ? photo.photoThumbUrl : null,
          item.tags, item.allergens,
          // is_available копируется как есть: позиция, которой сегодня нет в источнике, скорее
          // всего отсутствует и в новой точке — стоп-лист проще снять, чем заметить лишнее.
          item.is_available, item.sort_order, item.calories,
          item.weight_value, item.weight_unit, item.cooking_time_minutes,
          item.spicy_level, item.is_popular,
        ]
      );
      itemIdMap.set(item.id, created.rows[0].id);
    }

    const groupIdMap = new Map();
    for (const group of source.groups) {
      const newItemId = itemIdMap.get(group.item_id);
      if (!newItemId) continue;
      // eslint-disable-next-line no-await-in-loop
      const created = await client.query(
        `INSERT INTO item_option_groups (item_id, name_ru, name_uz, name_en, selection, is_required, min_select, max_select, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          newItemId, group.name_ru, group.name_uz, group.name_en, group.selection,
          group.is_required, group.min_select, group.max_select, group.sort_order,
        ]
      );
      groupIdMap.set(group.id, created.rows[0].id);
    }

    for (const option of source.options) {
      const newGroupId = groupIdMap.get(option.group_id);
      if (!newGroupId) continue;
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO item_options (group_id, name_ru, name_uz, name_en, price_delta, is_available, is_default, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newGroupId, option.name_ru, option.name_uz, option.name_en,
          // Надбавка к цене — тоже цена: при обнулении она обнуляется вместе с базовой,
          // иначе у бесплатного блюда остался бы платный вариант.
          withPrices ? option.price_delta : 0,
          option.is_available, option.is_default, option.sort_order,
        ]
      );
    }

    await logAction(client, {
      adminId: actorAdminId,
      venueId: targetVenueId,
      actionType: 'create',
      entityType: 'menu_copy',
      entityId: sourceVenueId,
      details: {
        source_venue_id: sourceVenueId,
        categories: categoryIdMap.size,
        items: itemIdMap.size,
        with_photos: Boolean(withPhotos),
        with_prices: Boolean(withPrices),
      },
    });

    await client.query('COMMIT');
    return { categories: categoryIdMap.size, items: itemIdMap.size };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await photoService.deleteFiles(copiedFiles);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { preview, copyMenu };
