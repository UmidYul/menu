const express = require('express');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const { venueStatusGate } = require('../middlewares/venueStatusGate');
const { pool } = require('../config/db');
const stoplistModel = require('../models/stoplistModel');
const venueModel = require('../models/venueModel');
const { logAction } = require('../models/adminActionLogModel');
const { pickLocalized } = require('../utils/localize');
const pgNotify = require('../services/pgNotify');

// Экран доступен и официанту, и владельцу: владелец должен видеть тот же стоп-лист, что и его
// персонал, хотя бы чтобы понимать, что происходит в зале.
// venueStatusGate — общий: у приостановленного заведения редактирования меню быть не должно
// ни у кого, а staff по промту в suspended вообще не пускают (см. routes/adminAuth.js).
router.use(requireAuth, requireVenueRole(['owner', 'manager', 'staff']), venueStatusGate);

function venueId(req) {
  return req.session.admin.venueId;
}

// Общая для всех мутаций часть: записать в журнал (промт: «все действия staff логируются
// с указанием, кто именно») и поднять menu_version со сбросом кэша меню — без этого гости
// продолжали бы видеть выключенную позицию до истечения TTL (edge case промта).
async function logAndPublish(req, entries) {
  for (const entry of entries) {
    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: venueId(req),
      actionType: 'toggle_availability',
      entityType: entry.entityType,
      entityId: entry.entityId,
      details: entry.details,
    });
  }
  await pgNotify.publishMenuChange(venueId(req));
}

router.get('/', async (req, res, next) => {
  try {
    const lang = res.locals.lang;
    const [venue, items, options] = await Promise.all([
      venueModel.findById(venueId(req)),
      stoplistModel.listItems(venueId(req)),
      stoplistModel.listOptions(venueId(req)),
    ]);

    // Варианты опций подшиваются к своим позициям здесь, а не отдельным запросом на строку:
    // на экране их сотни, и по запросу на каждую позицию страница открывалась бы секундами.
    const optionsByItem = new Map();
    options.forEach((option) => {
      if (!optionsByItem.has(option.item_id)) optionsByItem.set(option.item_id, []);
      optionsByItem.get(option.item_id).push({
        id: option.id,
        name: pickLocalized(option, 'name', lang),
        groupName: pickLocalized(
          { name_ru: option.group_name_ru, name_uz: option.group_name_uz, name_en: option.group_name_en },
          'name',
          lang
        ),
        isAvailable: option.is_available,
      });
    });

    const rows = items.map((item) => ({
      id: item.id,
      name: pickLocalized(item, 'name', lang),
      categoryName: pickLocalized(
        { name_ru: item.category_name_ru, name_uz: item.category_name_uz, name_en: item.category_name_en },
        'name',
        lang
      ),
      price: Number(item.price),
      currency: item.currency,
      photoThumbUrl: item.photo_thumb_url,
      isAvailable: item.is_available,
      options: optionsByItem.get(item.id) || [],
      // «Выключил Азиз, 14:20» — только пока позиция ДЕЙСТВИТЕЛЬНО выключена.
      //
      // Двух условий здесь два, и оба нужны. is_available — потому что «Вернуть всё в наличие»
      // пишет в журнал одну сводную запись на всё действие (иначе аудит утонул бы в сотне строк),
      // и последняя ПОЗИЦИОННАЯ запись после него остаётся «выключил» — подпись на уже
      // включённой позиции была бы враньём. last_toggle_value — потому что «включил» и так
      // видно по самому переключателю, лишний текст на строке официанту не нужен.
      lastToggleBy: !item.is_available && item.last_toggle_value === false ? item.last_toggle_by : null,
      lastToggleAt: !item.is_available && item.last_toggle_value === false ? item.last_toggle_at : null,
    }));

    const unavailableCount = rows.filter((row) => !row.isAvailable).length
      + rows.reduce((sum, row) => sum + row.options.filter((option) => !option.isAvailable).length, 0);

    res.render('admin/stoplist', {
      rows,
      unavailableCount,
      venueName: venue.name,
      venueTimezone: venue.timezone,
      login: req.session.admin.login,
      displayName: req.session.admin.displayName || req.session.admin.login,
      role: req.session.admin.role,
      ordersEnabled: Boolean(venue.orders_enabled && venue.telegram_chat_id && !venue.telegram_chat_broken),
    });
  } catch (err) {
    next(err);
  }
});

// Сверка состояний. Телефон официанта лежит в кармане часами — при возврате вкладки на передний
// план клиент дёргает этот эндпоинт и перерисовывает переключатели, вместо того чтобы верить
// тому, что было на экране полчаса назад.
router.get('/state', async (req, res, next) => {
  try {
    const states = await stoplistModel.listStates(venueId(req));
    res.set('Cache-Control', 'no-store');
    res.json({
      items: states.items.map((row) => ({ id: row.id, isAvailable: row.is_available })),
      options: states.options.map((row) => ({ id: row.id, isAvailable: row.is_available })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/items/:id/toggle', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_request' });

    const updated = await stoplistModel.toggleItem(id, venueId(req));
    // null означает «позиции нет или она чужая» — для клиента это одно и то же, отвечаем 404
    // без подробностей: по разнице ответов можно было бы перебором узнать чужие id.
    if (!updated) return res.status(404).json({ error: 'not_found' });

    await logAndPublish(req, [{
      entityType: 'item',
      entityId: updated.id,
      details: { name_ru: updated.name_ru, is_available: updated.is_available, source: 'stoplist' },
    }]);

    // Возвращаем ФАКТИЧЕСКОЕ состояние из БД, а не то, что предполагал клиент: если параллельно
    // ту же позицию переключил второй официант, интерфейс подтянет верное значение сам.
    return res.json({
      id: updated.id,
      isAvailable: updated.is_available,
      by: req.session.admin.displayName || req.session.admin.login,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/options/:id/toggle', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_request' });

    const updated = await stoplistModel.toggleOption(id, venueId(req));
    if (!updated) return res.status(404).json({ error: 'not_found' });

    await logAndPublish(req, [{
      entityType: 'item',
      entityId: updated.id,
      details: { option_name_ru: updated.name_ru, is_available: updated.is_available, source: 'stoplist_option' },
    }]);

    return res.json({ id: updated.id, isAvailable: updated.is_available });
  } catch (err) {
    return next(err);
  }
});

// «Вернуть всё в наличие» — утреннее действие одной кнопкой. Подтверждение спрашивает клиент.
router.post('/restore-all', async (req, res, next) => {
  try {
    const restored = await stoplistModel.restoreAll(venueId(req));
    const total = restored.itemIds.length + restored.optionIds.length;

    if (total > 0) {
      // Одна запись в журнал на всё действие, а не по строке на каждую позицию: «вернул всё
      // в наличие» — это одно осмысленное действие человека, и сотня строк в аудите
      // сделала бы журнал нечитаемым.
      await logAction(pool, {
        adminId: req.session.admin.id,
        venueId: venueId(req),
        actionType: 'toggle_availability',
        entityType: 'venue',
        entityId: venueId(req),
        details: { restored_items: restored.itemIds.length, restored_options: restored.optionIds.length, source: 'stoplist_restore_all' },
      });
      await pgNotify.publishMenuChange(venueId(req));
    }

    return res.json({ restoredItems: restored.itemIds, restoredOptions: restored.optionIds });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
