const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { venueStatusGate } = require('../middlewares/venueStatusGate');
const { pool } = require('../config/db');
const itemModel = require('../models/itemModel');
const categoryModel = require('../models/categoryModel');
const venueModel = require('../models/venueModel');
const { pickLocalized } = require('../utils/localize');
const { logAction } = require('../models/adminActionLogModel');
const { itemSchema, ALLOWED_TAGS } = require('../validators/itemValidators');
const { saveItemPhoto, deleteItemPhotoFiles } = require('../services/photoService');
const pgNotify = require('../services/pgNotify');

router.use(requireAuth, venueStatusGate);

const { groupByCategory } = itemModel;

// Список позиций без перевода на EN — считается по уже загруженным данным, без отдельного
// SQL-запроса (name_en пусто/NULL = не переведено).
function isUntranslatedToEn(item) {
  return !item.name_en || !String(item.name_en).trim();
}

async function renderList(req, res, status, error, formValues, formTarget) {
  const venueId = req.session.admin.venueId;
  const role = req.session.admin.role;

  const [items, categories, langSettings] = await Promise.all([
    itemModel.listByVenueGrouped(venueId),
    categoryModel.listByVenue(venueId),
    venueModel.getLangSettings(venueId),
  ]);

  const enabledLangs = (langSettings && langSettings.enabled_langs) || ['ru', 'uz'];
  const enBadgeEnabled = enabledLangs.includes('en');
  const totalCount = items.length;
  const translatedCount = items.filter((item) => !isUntranslatedToEn(item)).length;

  const showOnlyUntranslated = enBadgeEnabled && req.query.untranslated === 'en';
  const visibleItems = showOnlyUntranslated ? items.filter(isUntranslatedToEn) : items;

  // Заголовок категории — на языке интерфейса самой админки (res.locals.lang), а не заведения:
  // group.categoryNameRu/Uz/En приходят как есть из groupByCategory, здесь только выбор нужного.
  const groups = groupByCategory(visibleItems).map((group) => ({
    ...group,
    categoryName: pickLocalized(
      { name_ru: group.categoryNameRu, name_uz: group.categoryNameUz, name_en: group.categoryNameEn },
      'name',
      res.locals.lang
    ),
  }));

  res.status(status || 200).render('admin/items', {
    groups,
    categories,
    allowedTags: ALLOWED_TAGS,
    enabledLangs,
    enBadgeEnabled,
    totalCount,
    translatedCount,
    showOnlyUntranslated,
    isUntranslatedToEn,
    error: error || null,
    formValues: formValues || { category_id: '', name_ru: '', name_uz: '', name_en: '', description_ru: '', description_uz: '', description_en: '', composition_ru: '', composition_uz: '', composition_en: '', calories: '', price: '', old_price: '', currency: 'UZS', tags: [] },
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
    name_en: typeof body.name_en === 'string' ? body.name_en : '',
    description_ru: typeof body.description_ru === 'string' ? body.description_ru : '',
    description_uz: typeof body.description_uz === 'string' ? body.description_uz : '',
    description_en: typeof body.description_en === 'string' ? body.description_en : '',
    composition_ru: typeof body.composition_ru === 'string' ? body.composition_ru : '',
    composition_uz: typeof body.composition_uz === 'string' ? body.composition_uz : '',
    composition_en: typeof body.composition_en === 'string' ? body.composition_en : '',
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

// uploadItemPhoto применяется уровнем выше, в app.js (до csrfProtection — см. комментарий там).
router.post('/', requireRole(['venue_admin']), async (req, res, next) => {
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
      nameEn: parsed.data.name_en,
      descriptionRu: parsed.data.description_ru,
      descriptionUz: parsed.data.description_uz,
      descriptionEn: parsed.data.description_en,
      compositionRu: parsed.data.composition_ru,
      compositionUz: parsed.data.composition_uz,
      compositionEn: parsed.data.composition_en,
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

    await pgNotify.publishMenuChange(venueId);
    res.redirect('/admin/items');
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole(['venue_admin']), async (req, res, next) => {
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
      nameEn: parsed.data.name_en,
      descriptionRu: parsed.data.description_ru,
      descriptionUz: parsed.data.description_uz,
      descriptionEn: parsed.data.description_en,
      compositionRu: parsed.data.composition_ru,
      compositionUz: parsed.data.composition_uz,
      compositionEn: parsed.data.composition_en,
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

    await pgNotify.publishMenuChange(venueId);
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

    await pgNotify.publishMenuChange(req.session.admin.venueId);
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

    await pgNotify.publishMenuChange(req.session.admin.venueId);
    const redirectTo = req.body.redirect === '/admin' ? '/admin' : '/admin/items';
    res.redirect(redirectTo);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
