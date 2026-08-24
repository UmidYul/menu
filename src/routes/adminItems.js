const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const itemModel = require('../models/itemModel');
const categoryModel = require('../models/categoryModel');
const { logAction } = require('../models/adminActionLogModel');
const { itemSchema, ALLOWED_TAGS } = require('../validators/itemValidators');
const { uploadItemPhoto } = require('../middlewares/upload');
const { saveItemPhoto, deleteItemPhotoFiles } = require('../services/photoService');
const menuCache = require('../services/menuCache');

router.use(requireAuth);

const { groupByCategory } = itemModel;

async function renderList(req, res, status, error, formValues, formTarget) {
  const venueId = req.session.admin.venueId;
  const role = req.session.admin.role;

  const [items, categories] = await Promise.all([
    itemModel.listByVenueGrouped(venueId),
    categoryModel.listByVenue(venueId),
  ]);
  res.status(status || 200).render('admin/items', {
    groups: groupByCategory(items),
    categories,
    allowedTags: ALLOWED_TAGS,
    error: error || null,
    formValues: formValues || { category_id: '', name_ru: '', name_uz: '', description_ru: '', description_uz: '', composition_ru: '', composition_uz: '', calories: '', price: '', old_price: '', currency: 'UZS', tags: [] },
    formTarget: formTarget || null,
    login: req.session.admin.login,
    role,
    venueSlug: req.session.admin.venueSlug,
  });
}

function readFormValues(body) {
  const tags = body.tags === undefined ? [] : Array.isArray(body.tags) ? body.tags : [body.tags];
  return {
    category_id: typeof body.category_id === 'string' ? body.category_id : '',
    name_ru: typeof body.name_ru === 'string' ? body.name_ru : '',
    name_uz: typeof body.name_uz === 'string' ? body.name_uz : '',
    description_ru: typeof body.description_ru === 'string' ? body.description_ru : '',
    description_uz: typeof body.description_uz === 'string' ? body.description_uz : '',
    composition_ru: typeof body.composition_ru === 'string' ? body.composition_ru : '',
    composition_uz: typeof body.composition_uz === 'string' ? body.composition_uz : '',
    calories: typeof body.calories === 'string' ? body.calories : '',
    price: typeof body.price === 'string' ? body.price : '',
    old_price: typeof body.old_price === 'string' ? body.old_price : '',
    currency: typeof body.currency === 'string' ? body.currency : 'UZS',
    tags,
  };
}

// Загружает позицию по id и проверяет, что она принадлежит текущему заведению
// (через категорию, к которой привязана позиция). Сама отправляет 404 при несовпадении.
async function loadOwnItemOr404(req, res) {
  const { t } = res.locals;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).render('errors/message', {
      title: t('items.notFoundTitle'),
      message: t('items.notFoundMessage'),
      backUrl: '/admin/items',
    });
    return null;
  }

  const item = await itemModel.findById(id);
  if (!item || item.category_venue_id !== req.session.admin.venueId) {
    res.status(404).render('errors/message', {
      title: t('items.notFoundTitle'),
      message: t('items.notFoundForeignMessage'),
      backUrl: '/admin/items',
    });
    return null;
  }

  return item;
}

router.get('/', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    await renderList(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole(['venue_admin']), uploadItemPhoto, async (req, res, next) => {
  const { t } = res.locals;
  try {
    if (req.uploadError) {
      return renderList(req, res, 400, req.uploadError, readFormValues(req.body), 'add');
    }

    const parsed = itemSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderList(req, res, 400, t(parsed.error.issues[0].message), readFormValues(req.body), 'add');
    }

    const venueId = req.session.admin.venueId;
    const belongs = await itemModel.categoryBelongsToVenue(parsed.data.category_id, venueId);
    if (!belongs) {
      return renderList(req, res, 400, t('items.errorCategoryNotFound'), readFormValues(req.body), 'add');
    }

    let photo = null;
    if (req.file) {
      try {
        photo = await saveItemPhoto(venueId, req.file.buffer);
      } catch (err) {
        if (err.message === 'IMAGE_PROCESSING_FAILED') {
          return renderList(req, res, 400, t('items.errorImageProcessing'), readFormValues(req.body), 'add');
        }
        throw err;
      }
    }

    const item = await itemModel.create({
      categoryId: parsed.data.category_id,
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
      descriptionRu: parsed.data.description_ru,
      descriptionUz: parsed.data.description_uz,
      compositionRu: parsed.data.composition_ru,
      compositionUz: parsed.data.composition_uz,
      calories: parsed.data.calories,
      price: parsed.data.price,
      oldPrice: parsed.data.old_price,
      currency: parsed.data.currency,
      tags: parsed.data.tags,
      photoUrl: photo ? photo.photoUrl : null,
      photoThumbUrl: photo ? photo.photoThumbUrl : null,
    });

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'create',
      entityType: 'item',
      entityId: item.id,
      details: { name_ru: item.name_ru, name_uz: item.name_uz, price: item.price, category_id: item.category_id },
    });

    menuCache.invalidateVenue(req.session.admin.venueSlug);
    res.redirect('/admin/items');
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole(['venue_admin']), uploadItemPhoto, async (req, res, next) => {
  const { t } = res.locals;
  try {
    const item = await loadOwnItemOr404(req, res);
    if (!item) return;

    const formTarget = `edit-${item.id}`;

    if (req.uploadError) {
      return renderList(req, res, 400, req.uploadError, readFormValues(req.body), formTarget);
    }

    const parsed = itemSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderList(req, res, 400, t(parsed.error.issues[0].message), readFormValues(req.body), formTarget);
    }

    const venueId = req.session.admin.venueId;
    const belongs = await itemModel.categoryBelongsToVenue(parsed.data.category_id, venueId);
    if (!belongs) {
      return renderList(req, res, 400, t('items.errorCategoryNotFound'), readFormValues(req.body), formTarget);
    }

    let photo = null;
    if (req.file) {
      try {
        photo = await saveItemPhoto(venueId, req.file.buffer);
      } catch (err) {
        if (err.message === 'IMAGE_PROCESSING_FAILED') {
          return renderList(req, res, 400, t('items.errorImageProcessing'), readFormValues(req.body), formTarget);
        }
        throw err;
      }
    }

    const before = { name_ru: item.name_ru, name_uz: item.name_uz, price: item.price, category_id: item.category_id };
    const oldPhotoUrl = item.photo_url;
    const oldPhotoThumbUrl = item.photo_thumb_url;
    const updated = await itemModel.update(item.id, {
      categoryId: parsed.data.category_id,
      nameRu: parsed.data.name_ru,
      nameUz: parsed.data.name_uz,
      descriptionRu: parsed.data.description_ru,
      descriptionUz: parsed.data.description_uz,
      compositionRu: parsed.data.composition_ru,
      compositionUz: parsed.data.composition_uz,
      calories: parsed.data.calories,
      price: parsed.data.price,
      oldPrice: parsed.data.old_price,
      currency: parsed.data.currency,
      tags: parsed.data.tags,
      photoUrl: photo ? photo.photoUrl : null,
      photoThumbUrl: photo ? photo.photoThumbUrl : null,
    });

    if (photo) {
      await deleteItemPhotoFiles(oldPhotoUrl, oldPhotoThumbUrl);
    }

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'update',
      entityType: 'item',
      entityId: updated.id,
      details: {
        before,
        after: { name_ru: updated.name_ru, name_uz: updated.name_uz, price: updated.price, category_id: updated.category_id },
      },
    });

    menuCache.invalidateVenue(req.session.admin.venueSlug);
    res.redirect('/admin/items');
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    const item = await loadOwnItemOr404(req, res);
    if (!item) return;

    await itemModel.remove(item.id);
    await deleteItemPhotoFiles(item.photo_url, item.photo_thumb_url);

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'delete',
      entityType: 'item',
      entityId: item.id,
      details: { name_ru: item.name_ru, name_uz: item.name_uz },
    });

    menuCache.invalidateVenue(req.session.admin.venueSlug);
    res.redirect('/admin/items');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/toggle', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    const item = await loadOwnItemOr404(req, res);
    if (!item) return;

    const updated = await itemModel.toggleAvailability(item.id);

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'toggle_availability',
      entityType: 'item',
      entityId: updated.id,
      details: { name_ru: updated.name_ru, is_available: updated.is_available },
    });

    menuCache.invalidateVenue(req.session.admin.venueSlug);
    const redirectTo = req.body.redirect === '/admin' ? '/admin' : '/admin/items';
    res.redirect(redirectTo);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
