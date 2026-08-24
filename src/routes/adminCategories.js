const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const categoryModel = require('../models/categoryModel');
const { logAction } = require('../models/adminActionLogModel');
const { categorySchema } = require('../validators/categoryValidators');
const menuCache = require('../services/menuCache');

router.use(requireAuth, requireRole(['venue_admin']));

async function renderList(req, res, status, error, formValues, formTarget) {
  const venueId = req.session.admin.venueId;
  const categories = await categoryModel.listByVenueWithCounts(venueId);
  res.status(status || 200).render('admin/categories', {
    categories,
    error: error || null,
    formValues: formValues || { name_ru: '', name_uz: '' },
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
      }, 'add');
    }

    const venueId = req.session.admin.venueId;
    const category = await categoryModel.create(venueId, {
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
    });

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'create',
      entityType: 'category',
      entityId: category.id,
      details: { name_ru: category.name_ru, name_uz: category.name_uz },
    });

    menuCache.invalidateVenue(req.session.admin.venueSlug);
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
    const updated = await categoryModel.update(category.id, {
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
    });

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'update',
      entityType: 'category',
      entityId: updated.id,
      details: { before, after: { name_ru: updated.name_ru, name_uz: updated.name_uz } },
    });

    menuCache.invalidateVenue(req.session.admin.venueSlug);
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

    await categoryModel.remove(category.id);

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'delete',
      entityType: 'category',
      entityId: category.id,
      details: { name_ru: category.name_ru, name_uz: category.name_uz },
    });

    menuCache.invalidateVenue(req.session.admin.venueSlug);
    res.redirect('/admin/categories');
  } catch (err) {
    if (err.code === '23503') {
      return renderList(req, res, 409, t('categories.errorHasItemsGeneric'));
    }
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
      await categoryModel.swapOrder(client, ordered[index], ordered[neighborIndex]);
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

    menuCache.invalidateVenue(req.session.admin.venueSlug);
    res.redirect('/admin/categories');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
