const express = require('express');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const { venueStatusGate } = require('../middlewares/venueStatusGate');
const { pool } = require('../config/db');
const categoryModel = require('../models/categoryModel');
const venueModel = require('../models/venueModel');
const { logAction } = require('../models/adminActionLogModel');
const { categorySchema } = require('../validators/categoryValidators');
const scheduleModel = require('../models/availabilityScheduleModel');
const availability = require('../services/availability');
const pgNotify = require('../services/pgNotify');
const demoData = require('../services/demoData');

router.use(requireAuth, requireVenueRole(['owner', 'manager']), venueStatusGate);

// Промт 2.3. Для каждой категории — её интервалы, «сейчас доступно» и предупреждения.
// Состояние считается в часовом поясе ЗАВЕДЕНИЯ, а не сервера: владелец должен видеть ровно то,
// что видит гость (venueNow, см. services/availability.js).
function buildScheduleState(categories, schedules, venue) {
  const { byCategory } = scheduleModel.groupByEntity(schedules);
  const now = availability.venueNow(venue && venue.timezone);
  const stateByCategory = new Map();

  categories.forEach((category) => {
    const rules = byCategory.get(category.id) || [];
    stateByCategory.set(category.id, {
      availableNow: availability.isAvailableNow(rules, now),
      warnings: availability.scheduleWarnings(rules, { isAvailable: true }),
    });
  });

  return { schedulesByCategory: byCategory, scheduleStateByCategory: stateByCategory };
}

async function renderList(req, res, status, error, formValues, formTarget) {
  const venueId = req.session.admin.venueId;
  const [categories, langSettings, schedules, venue] = await Promise.all([
    categoryModel.listByVenueWithCounts(venueId),
    venueModel.getLangSettings(venueId),
    scheduleModel.listByVenue(venueId),
    venueModel.findById(venueId),
  ]);
  const enabledLangs = (langSettings && langSettings.enabled_langs) || ['ru', 'uz'];
  const scheduleCategoryId = Number(req.query.schedule_category) || null;

  res.status(status || 200).render('admin/categories', {
    categories,
    enabledLangs,
    ...buildScheduleState(categories, schedules, venue),
    maxScheduleRules: scheduleModel.MAX_RULES_PER_ENTITY,
    // Ошибка расписания приходит КЛЮЧОМ словаря в query от /admin/schedules (см. redirectBack
    // там) — переводится здесь, в шаблоне. Ключ проверяем по префиксу, чтобы произвольная
    // строка из адресной строки не попала в t() и не отрисовалась как текст.
    scheduleError: typeof req.query.schedule_error === 'string' && req.query.schedule_error.startsWith('schedules.')
      ? req.query.schedule_error
      : null,
    scheduleCategoryId,
    error: error || null,
    formValues: formValues || { name_ru: '', name_uz: '', name_en: '' },
    formTarget: formTarget || null,
    login: req.session.admin.login,
    role: req.session.admin.role,
    venueSlug: req.session.admin.venueSlug,
  });
}

// Загружает категорию по id и проверяет, что она принадлежит текущему заведению.
// Возвращает null и сама отправляет 404, если категория не найдена или чужая.
async function loadOwnCategoryOr404(req, res) {
  const { t } = res.locals;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).render('errors/message', {
      title: t('categories.notFoundTitle'),
      message: t('categories.notFoundMessage'),
      backUrl: '/admin/categories',
    });
    return null;
  }

  const category = await categoryModel.findById(id);
  if (!category || category.venue_id !== req.session.admin.venueId) {
    res.status(404).render('errors/message', {
      title: t('categories.notFoundTitle'),
      message: t('categories.notFoundForeignMessage'),
      backUrl: '/admin/categories',
    });
    return null;
  }

  return category;
}

router.get('/', async (req, res, next) => {
  try {
    await renderList(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) {
      return renderList(req, res, 400, t(parsed.error.issues[0].message), {
        name_ru: typeof req.body.name_ru === 'string' ? req.body.name_ru : '',
        name_uz: typeof req.body.name_uz === 'string' ? req.body.name_uz : '',
        name_en: typeof req.body.name_en === 'string' ? req.body.name_en : '',
      }, 'add');
    }

    const venueId = req.session.admin.venueId;
    const category = await categoryModel.create(venueId, {
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
      nameEn: parsed.data.name_en,
    });

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'create',
      entityType: 'category',
      entityId: category.id,
      details: { name_ru: category.name_ru, name_uz: category.name_uz },
    });

    await pgNotify.publishMenuChange(venueId);
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const category = await loadOwnCategoryOr404(req, res);
    if (!category) return;

    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) {
      return renderList(req, res, 400, t(parsed.error.issues[0].message), null, `edit-${category.id}`);
    }

    const before = { name_ru: category.name_ru, name_uz: category.name_uz };
    const updated = await categoryModel.update(category.id, req.session.admin.venueId, {
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
      nameEn: parsed.data.name_en,
      scheduleHiddenMode: parsed.data.schedule_hidden_mode,
    });
    // null — категория перестала принадлежать активному заведению между проверкой и записью
    // (venue_id теперь в WHERE самого UPDATE, см. categoryModel).
    if (!updated) return res.status(404).render('errors/403');

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'update',
      entityType: 'category',
      entityId: updated.id,
      details: {
        before,
        after: {
          name_ru: updated.name_ru,
          name_uz: updated.name_uz,
          schedule_hidden_mode: updated.schedule_hidden_mode,
        },
      },
    });

    await pgNotify.publishMenuChange(req.session.admin.venueId);
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const category = await loadOwnCategoryOr404(req, res);
    if (!category) return;

    const itemsCount = await categoryModel.countItems(category.id);
    if (itemsCount > 0) {
      return renderList(
        req,
        res,
        409,
        t('categories.errorHasItems', { name: category.name_ru, count: itemsCount })
      );
    }

    const removed = await categoryModel.remove(category.id, req.session.admin.venueId);
    if (!removed) return res.status(404).render('errors/403');

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'delete',
      entityType: 'category',
      entityId: category.id,
      details: { name_ru: category.name_ru, name_uz: category.name_uz },
    });

    await pgNotify.publishMenuChange(req.session.admin.venueId);
    res.redirect('/admin/categories');
  } catch (err) {
    if (err.code === '23503') {
      return renderList(req, res, 409, t('categories.errorHasItemsGeneric'));
    }
    next(err);
  }
});

// Промт 1.6 — "Заполнить примером" в пустом состоянии категорий. Реальное содержание меню
// после этого создаётся тем же путём, что и вручную (categoryModel.create/itemModel.create),
// просто с is_demo=true — pgNotify нужен так же, как и для настоящей категории/позиции.
router.post('/demo-fill', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const result = await demoData.fillWithDemoData(venueId);
    if (result.created) {
      await logAction(pool, {
        adminId: req.session.admin.id,
        venueId,
        actionType: 'create',
        entityType: 'venue',
        entityId: venueId,
        details: { action: 'demo_fill' },
      });
      await pgNotify.publishMenuChange(venueId);
    }
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

router.post('/demo-remove', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    await demoData.removeDemoData(venueId);
    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'delete',
      entityType: 'venue',
      entityId: venueId,
      details: { action: 'demo_remove' },
    });
    await pgNotify.publishMenuChange(venueId);
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/move', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const category = await loadOwnCategoryOr404(req, res);
    if (!category) return;

    const direction = req.body.direction;
    if (direction !== 'up' && direction !== 'down') {
      return renderList(req, res, 400, t('categories.errorInvalidDirection'));
    }

    const venueId = req.session.admin.venueId;
    const ordered = await categoryModel.listByVenue(venueId);
    const index = ordered.findIndex((c) => c.id === category.id);
    const neighborIndex = direction === 'up' ? index - 1 : index + 1;

    if (neighborIndex < 0 || neighborIndex >= ordered.length) {
      return res.redirect('/admin/categories');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await categoryModel.swapOrder(client, req.session.admin.venueId, ordered[index], ordered[neighborIndex]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'update',
      entityType: 'category',
      entityId: category.id,
      details: { moved: direction },
    });

    await pgNotify.publishMenuChange(venueId);
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
