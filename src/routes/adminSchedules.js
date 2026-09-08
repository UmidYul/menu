const express = require('express');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const { venueStatusGate } = require('../middlewares/venueStatusGate');
const { pool } = require('../config/db');
const categoryModel = require('../models/categoryModel');
const itemModel = require('../models/itemModel');
const scheduleModel = require('../models/availabilityScheduleModel');
const { logAction } = require('../models/adminActionLogModel');
const { scheduleRuleSchema } = require('../validators/scheduleValidators');
const pgNotify = require('../services/pgNotify');

router.use(requireAuth, requireVenueRole(['owner', 'manager']), venueStatusGate);

// Расписания редактируются внутри форм категории и позиции, поэтому и ошибки показываются там же
// (тот же приём, что у групп опций в промте 2.1): в query уходит КЛЮЧ словаря, а не переведённый
// текст — тащить через адресную строку готовые строки незачем.
function redirectBack(res, target, errorKey) {
  const base = target.categoryId ? '/admin/categories' : '/admin/items';
  if (!errorKey) return res.redirect(base);

  const params = new URLSearchParams({ schedule_error: errorKey });
  if (target.categoryId) params.set('schedule_category', String(target.categoryId));
  else params.set('schedule_item', String(target.itemId));
  return res.redirect(`${base}?${params.toString()}`);
}

// Владение проверяется запросом к БД, а не доверием к id из формы: категория должна принадлежать
// заведению из сессии, позиция — через свою категорию (itemModel.findById отдаёт venue_id).
async function loadOwnCategory(req) {
  const categoryId = Number(req.params.categoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) return null;
  const category = await categoryModel.findById(categoryId);
  if (!category || category.venue_id !== req.session.admin.venueId) return null;
  return category;
}

async function loadOwnItem(req) {
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  const item = await itemModel.findById(itemId);
  if (!item || item.category_venue_id !== req.session.admin.venueId) return null;
  return item;
}

async function loadOwnRule(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const rule = await scheduleModel.findByIdWithVenue(id);
  if (!rule || rule.venue_id !== req.session.admin.venueId) return null;
  return rule;
}

// Куда возвращаться и что писать в журнал — зависит только от того, к чему привязано правило.
function ruleTarget(rule) {
  return rule.category_id ? { categoryId: rule.category_id } : { itemId: rule.item_id };
}

async function logSchedule(req, actionType, entityId, details) {
  await logAction(pool, {
    adminId: req.session.admin.id,
    venueId: req.session.admin.venueId,
    actionType,
    entityType: 'schedule',
    entityId,
    details,
  });
}

// --- добавление интервала -------------------------------------------------------------------

router.post('/category/:categoryId', async (req, res, next) => {
  try {
    const category = await loadOwnCategory(req);
    if (!category) return redirectBack(res, { categoryId: 0 }, 'schedules.errorNotFound');

    const target = { categoryId: category.id };
    const count = await scheduleModel.countForCategory(category.id);
    if (count >= scheduleModel.MAX_RULES_PER_ENTITY) {
      return redirectBack(res, target, 'schedules.errorTooManyRules');
    }

    const parsed = scheduleRuleSchema.safeParse(req.body);
    if (!parsed.success) return redirectBack(res, target, parsed.error.issues[0].message);

    const rule = await scheduleModel.createForCategory(category.id, {
      days: parsed.data.days, timeFrom: parsed.data.time_from, timeTo: parsed.data.time_to,
    });

    await logSchedule(req, 'create', rule.id, {
      category_id: category.id, days: rule.days, from: parsed.data.time_from, to: parsed.data.time_to,
    });
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    return redirectBack(res, target);
  } catch (err) {
    return next(err);
  }
});

router.post('/item/:itemId', async (req, res, next) => {
  try {
    const item = await loadOwnItem(req);
    if (!item) return redirectBack(res, { itemId: 0 }, 'schedules.errorNotFound');

    const target = { itemId: item.id };
    const count = await scheduleModel.countForItem(item.id);
    if (count >= scheduleModel.MAX_RULES_PER_ENTITY) {
      return redirectBack(res, target, 'schedules.errorTooManyRules');
    }

    const parsed = scheduleRuleSchema.safeParse(req.body);
    if (!parsed.success) return redirectBack(res, target, parsed.error.issues[0].message);

    const rule = await scheduleModel.createForItem(item.id, {
      days: parsed.data.days, timeFrom: parsed.data.time_from, timeTo: parsed.data.time_to,
    });

    await logSchedule(req, 'create', rule.id, {
      item_id: item.id, days: rule.days, from: parsed.data.time_from, to: parsed.data.time_to,
    });
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    return redirectBack(res, target);
  } catch (err) {
    return next(err);
  }
});

// --- правка, включение/выключение, удаление ---------------------------------------------------

router.patch('/:id', async (req, res, next) => {
  try {
    const rule = await loadOwnRule(req);
    if (!rule) return redirectBack(res, { categoryId: 0 }, 'schedules.errorNotFound');

    const target = ruleTarget(rule);
    const parsed = scheduleRuleSchema.safeParse(req.body);
    if (!parsed.success) return redirectBack(res, target, parsed.error.issues[0].message);

    const updated = await scheduleModel.update(rule.id, req.session.admin.venueId, {
      days: parsed.data.days, timeFrom: parsed.data.time_from, timeTo: parsed.data.time_to,
    });
    // null — правило перестало принадлежать активному заведению между проверкой и записью
    // (venue теперь в WHERE самого UPDATE, см. availabilityScheduleModel).
    if (!updated) return redirectBack(res, target, 'schedules.errorNotFound');

    await logSchedule(req, 'update', rule.id, {
      days: updated.days, from: parsed.data.time_from, to: parsed.data.time_to,
    });
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    return redirectBack(res, target);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/toggle', async (req, res, next) => {
  try {
    const rule = await loadOwnRule(req);
    if (!rule) return redirectBack(res, { categoryId: 0 }, 'schedules.errorNotFound');

    const updated = await scheduleModel.toggleActive(rule.id, req.session.admin.venueId);
    if (!updated) return redirectBack(res, ruleTarget(rule), 'schedules.errorNotFound');
    await logSchedule(req, 'update', rule.id, { is_active: updated.is_active });
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    return redirectBack(res, ruleTarget(rule));
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const rule = await loadOwnRule(req);
    if (!rule) return redirectBack(res, { categoryId: 0 }, 'schedules.errorNotFound');

    const target = ruleTarget(rule);
    const removedRule = await scheduleModel.remove(rule.id, req.session.admin.venueId);
    if (!removedRule) return redirectBack(res, target, 'schedules.errorNotFound');
    await logSchedule(req, 'delete', rule.id, target);
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    return redirectBack(res, target);
  } catch (err) {
    return next(err);
  }
});

// --- «доступно всегда» ------------------------------------------------------------------------
// Отдельного флага «работает по расписанию» в схеме нет: его роль играет само наличие правил.
// Одно состояние вместо двух, которые могли бы разойтись между собой.

router.post('/category/:categoryId/clear', async (req, res, next) => {
  try {
    const category = await loadOwnCategory(req);
    if (!category) return redirectBack(res, { categoryId: 0 }, 'schedules.errorNotFound');

    const removed = await scheduleModel.removeAllForCategory(category.id, req.session.admin.venueId);
    if (removed > 0) {
      await logSchedule(req, 'delete', category.id, { category_id: category.id, cleared: removed });
      await pgNotify.publishMenuChange(req.session.admin.venueId);
    }
    return redirectBack(res, { categoryId: category.id });
  } catch (err) {
    return next(err);
  }
});

router.post('/item/:itemId/clear', async (req, res, next) => {
  try {
    const item = await loadOwnItem(req);
    if (!item) return redirectBack(res, { itemId: 0 }, 'schedules.errorNotFound');

    const removed = await scheduleModel.removeAllForItem(item.id, req.session.admin.venueId);
    if (removed > 0) {
      await logSchedule(req, 'delete', item.id, { item_id: item.id, cleared: removed });
      await pgNotify.publishMenuChange(req.session.admin.venueId);
    }
    return redirectBack(res, { itemId: item.id });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
