const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { venueStatusGate } = require('../middlewares/venueStatusGate');
const { pool } = require('../config/db');
const itemModel = require('../models/itemModel');
const itemOptionModel = require('../models/itemOptionModel');
const { logAction } = require('../models/adminActionLogModel');
const {
  MAX_GROUPS_PER_ITEM, MAX_OPTIONS_PER_GROUP, groupSchema, optionSchema, copyGroupSchema,
} = require('../validators/itemOptionValidators');
const pgNotify = require('../services/pgNotify');

router.use(requireAuth, requireRole(['venue_admin']), venueStatusGate);

// Ошибки этих форм показываются на /admin/items — там же, где и сами группы (промт 2.1:
// редактирование внутри формы позиции). Текст передаётся query-параметром с КЛЮЧОМ словаря,
// а не готовой строкой: подставлять в URL уже переведённый текст значило бы тащить
// пользовательский ввод через адресную строку.
function redirectBack(res, itemId, errorKey) {
  const suffix = errorKey ? `?option_error=${encodeURIComponent(errorKey)}&option_item=${itemId}` : '';
  res.redirect(`/admin/items${suffix}`);
}

async function loadOwnItem(req, res) {
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  const item = await itemModel.findById(itemId);
  if (!item || item.category_venue_id !== req.session.admin.venueId) return null;
  return item;
}

async function loadOwnGroup(req) {
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0) return null;
  const group = await itemOptionModel.findGroupWithVenue(groupId);
  if (!group || group.venue_id !== req.session.admin.venueId) return null;
  return group;
}

async function loadOwnOption(req) {
  const optionId = Number(req.params.optionId);
  if (!Number.isInteger(optionId) || optionId <= 0) return null;
  const option = await itemOptionModel.findOptionWithVenue(optionId);
  if (!option || option.venue_id !== req.session.admin.venueId) return null;
  return option;
}

router.post('/items/:itemId/groups', async (req, res, next) => {
  try {
    const item = await loadOwnItem(req, res);
    if (!item) return redirectBack(res, 0, 'itemOptions.errorItemNotFound');

    const count = await itemOptionModel.countGroupsForItem(item.id);
    if (count >= MAX_GROUPS_PER_ITEM) {
      return redirectBack(res, item.id, 'itemOptions.errorTooManyGroups');
    }

    const parsed = groupSchema.safeParse(req.body);
    if (!parsed.success) return redirectBack(res, item.id, parsed.error.issues[0].message);

    const group = await itemOptionModel.createGroup(item.id, {
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
      nameEn: parsed.data.name_en,
      selection: parsed.data.selection,
      isRequired: parsed.data.is_required,
      minSelect: parsed.data.min_select,
      maxSelect: parsed.data.max_select,
    });

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'create',
      entityType: 'item',
      entityId: item.id,
      details: { option_group: group.id, name_ru: group.name_ru },
    });
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, item.id);
  } catch (err) {
    next(err);
  }
});

router.patch('/groups/:groupId', async (req, res, next) => {
  try {
    const group = await loadOwnGroup(req);
    if (!group) return redirectBack(res, 0, 'itemOptions.errorGroupNotFound');

    const parsed = groupSchema.safeParse(req.body);
    if (!parsed.success) return redirectBack(res, group.item_id, parsed.error.issues[0].message);

    await itemOptionModel.updateGroup(group.id, {
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
      nameEn: parsed.data.name_en,
      selection: parsed.data.selection,
      isRequired: parsed.data.is_required,
      minSelect: parsed.data.min_select,
      maxSelect: parsed.data.max_select,
    });

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'update',
      entityType: 'item',
      entityId: group.item_id,
      details: { option_group: group.id, name_ru: parsed.data.name_ru },
    });
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, group.item_id);
  } catch (err) {
    next(err);
  }
});

router.delete('/groups/:groupId', async (req, res, next) => {
  try {
    const group = await loadOwnGroup(req);
    if (!group) return redirectBack(res, 0, 'itemOptions.errorGroupNotFound');

    await itemOptionModel.removeGroup(group.id);

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'delete',
      entityType: 'item',
      entityId: group.item_id,
      details: { option_group: group.id, name_ru: group.name_ru },
    });
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, group.item_id);
  } catch (err) {
    next(err);
  }
});

router.post('/groups/:groupId/move', async (req, res, next) => {
  try {
    const group = await loadOwnGroup(req);
    if (!group) return redirectBack(res, 0, 'itemOptions.errorGroupNotFound');

    const direction = req.body.direction;
    if (direction !== 'up' && direction !== 'down') return redirectBack(res, group.item_id);

    const ordered = await itemOptionModel.listGroupsPlainForItem(group.item_id);
    const index = ordered.findIndex((g) => g.id === group.id);
    const neighborIndex = direction === 'up' ? index - 1 : index + 1;
    if (neighborIndex < 0 || neighborIndex >= ordered.length) return redirectBack(res, group.item_id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await itemOptionModel.swapGroupOrder(client, ordered[index], ordered[neighborIndex]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, group.item_id);
  } catch (err) {
    next(err);
  }
});

router.post('/groups/:groupId/options', async (req, res, next) => {
  try {
    const group = await loadOwnGroup(req);
    if (!group) return redirectBack(res, 0, 'itemOptions.errorGroupNotFound');

    const count = await itemOptionModel.countOptionsInGroup(group.id);
    if (count >= MAX_OPTIONS_PER_GROUP) {
      return redirectBack(res, group.item_id, 'itemOptions.errorTooManyOptions');
    }

    const parsed = optionSchema.safeParse(req.body);
    if (!parsed.success) return redirectBack(res, group.item_id, parsed.error.issues[0].message);

    await itemOptionModel.createOption(group.id, {
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
      nameEn: parsed.data.name_en,
      priceDelta: parsed.data.price_delta,
      isAvailable: parsed.data.is_available,
      isDefault: parsed.data.is_default,
    });

    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, group.item_id);
  } catch (err) {
    next(err);
  }
});

router.patch('/options/:optionId', async (req, res, next) => {
  try {
    const option = await loadOwnOption(req);
    if (!option) return redirectBack(res, 0, 'itemOptions.errorOptionNotFound');

    const parsed = optionSchema.safeParse(req.body);
    if (!parsed.success) return redirectBack(res, option.item_id, parsed.error.issues[0].message);

    await itemOptionModel.updateOption(option.id, {
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
      nameEn: parsed.data.name_en,
      priceDelta: parsed.data.price_delta,
      isAvailable: parsed.data.is_available,
      isDefault: parsed.data.is_default,
    });

    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, option.item_id);
  } catch (err) {
    next(err);
  }
});

router.delete('/options/:optionId', async (req, res, next) => {
  try {
    const option = await loadOwnOption(req);
    if (!option) return redirectBack(res, 0, 'itemOptions.errorOptionNotFound');

    await itemOptionModel.removeOption(option.id);
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, option.item_id);
  } catch (err) {
    next(err);
  }
});

// Перетаскивание вариантов — единственный AJAX-эндпоинт этого файла (порядок приходит
// массивом id в JSON). Кнопки "вверх/вниз" рядом делают то же самое обычными формами:
// без JS и на тач-устройствах порядок всё равно можно менять.
router.post('/groups/:groupId/reorder', async (req, res, next) => {
  try {
    const group = await loadOwnGroup(req);
    if (!group) return res.status(404).json({ ok: false });

    const ids = Array.isArray(req.body.order)
      ? req.body.order.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (ids.length === 0) return res.status(400).json({ ok: false });

    await itemOptionModel.reorderOptions(group.id, ids);
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/options/:optionId/move', async (req, res, next) => {
  try {
    const option = await loadOwnOption(req);
    if (!option) return redirectBack(res, 0, 'itemOptions.errorOptionNotFound');

    const direction = req.body.direction;
    if (direction !== 'up' && direction !== 'down') return redirectBack(res, option.item_id);

    const groups = await itemOptionModel.listGroupsForItem(option.item_id);
    const group = groups.find((g) => g.id === option.group_id);
    if (!group) return redirectBack(res, option.item_id);

    const ordered = group.options;
    const index = ordered.findIndex((o) => o.id === option.id);
    const neighborIndex = direction === 'up' ? index - 1 : index + 1;
    if (neighborIndex < 0 || neighborIndex >= ordered.length) return redirectBack(res, option.item_id);

    const reordered = ordered.slice();
    const [moved] = reordered.splice(index, 1);
    reordered.splice(neighborIndex, 0, moved);
    await itemOptionModel.reorderOptions(group.id, reordered.map((o) => o.id));

    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, option.item_id);
  } catch (err) {
    next(err);
  }
});

// "Скопировать группу из другой позиции" и "применить к нескольким позициям" — одно и то же
// действие с разной стороны: источник группы + список целевых позиций. Целевые позиции
// проверяются на принадлежность заведению (в SQL, через categoryBelongsToVenue их родителя).
router.post('/groups/copy', async (req, res, next) => {
  try {
    const parsed = copyGroupSchema.safeParse(req.body);
    if (!parsed.success) return redirectBack(res, 0, parsed.error.issues[0].message);

    const source = await itemOptionModel.findGroupWithVenue(parsed.data.group_id);
    if (!source || source.venue_id !== req.session.admin.venueId) {
      return redirectBack(res, 0, 'itemOptions.errorGroupNotFound');
    }

    const ownItems = [];
    for (const targetId of parsed.data.target_item_ids) {
      const item = await itemModel.findById(targetId);
      if (!item || item.category_venue_id !== req.session.admin.venueId) continue;
      const count = await itemOptionModel.countGroupsForItem(item.id);
      if (count >= MAX_GROUPS_PER_ITEM) continue;
      ownItems.push(item.id);
    }

    if (ownItems.length === 0) return redirectBack(res, source.item_id, 'itemOptions.errorNoTargetItems');

    await itemOptionModel.copyGroupToItems(source.id, ownItems);

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'create',
      entityType: 'item',
      entityId: source.item_id,
      details: { copied_group: source.id, to_items: ownItems },
    });
    await pgNotify.publishMenuChange(req.session.admin.venueId);
    redirectBack(res, source.item_id);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
