const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { venueStatusGate } = require('../middlewares/venueStatusGate');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const { logAction } = require('../models/adminActionLogModel');
const { venueSettingsSchema } = require('../validators/venueSettingsValidators');
const { saveItemPhoto, deleteItemPhotoFiles } = require('../services/photoService');
const pgNotify = require('../services/pgNotify');

router.use(requireAuth, requireRole(['venue_admin']), venueStatusGate);

function toFormValues(venue) {
  return {
    phone: venue.phone || '',
    address: venue.address || '',
    address_2gis_url: venue.address_2gis_url || '',
    wifi_ssid: venue.wifi_ssid || '',
    wifi_password: venue.wifi_password || '',
    instagram_url: venue.instagram_url || '',
    telegram_url: venue.telegram_url || '',
    working_hours: venue.working_hours || '',
    description_ru: venue.description_ru || '',
    description_uz: venue.description_uz || '',
    description_en: venue.description_en || '',
    cuisine_ru: venue.cuisine_ru || '',
    cuisine_uz: venue.cuisine_uz || '',
    cuisine_en: venue.cuisine_en || '',
    category_label_ru: venue.category_label_ru || '',
    category_label_uz: venue.category_label_uz || '',
    category_label_en: venue.category_label_en || '',
    district_ru: venue.district_ru || '',
    district_uz: venue.district_uz || '',
    district_en: venue.district_en || '',
    email: venue.email || '',
    enabled_langs: venue.enabled_langs || ['ru', 'uz'],
    lang_default: venue.lang_default,
    logo_thumb_url: venue.logo_thumb_url || '',
    cover_thumb_url: venue.cover_thumb_url || '',
  };
}

function readRawFormValues(body) {
  const keys = [
    'phone', 'address', 'address_2gis_url', 'wifi_ssid', 'wifi_password', 'instagram_url', 'telegram_url',
    'working_hours', 'description_ru', 'description_uz', 'description_en', 'cuisine_ru', 'cuisine_uz', 'cuisine_en',
    'category_label_ru', 'category_label_uz', 'category_label_en',
    'district_ru', 'district_uz', 'district_en', 'email',
  ];
  const values = {};
  keys.forEach((key) => {
    values[key] = typeof body[key] === 'string' ? body[key] : '';
  });
  const rawLangs = body.enabled_langs;
  values.enabled_langs = rawLangs === undefined ? [] : Array.isArray(rawLangs) ? rawLangs : [rawLangs];
  values.lang_default = typeof body.lang_default === 'string' ? body.lang_default : '';
  values.logo_thumb_url = '';
  values.cover_thumb_url = '';
  return values;
}

async function renderForm(req, res, status, error, saved) {
  const venue = await venueModel.findById(req.session.admin.venueId);
  res.status(status || 200).render('admin/venue-settings', {
    formValues: toFormValues(venue),
    error: error || null,
    saved: !!saved,
    login: req.session.admin.login,
    role: req.session.admin.role,
    venueSlug: req.session.admin.venueSlug,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await renderForm(req, res);
  } catch (err) {
    next(err);
  }
});

// uploadVenueImages применяется уровнем выше, в app.js (до csrfProtection — см. комментарий там).
router.post('/', async (req, res, next) => {
  const { t } = res.locals;
  try {
    if (req.uploadError) {
      return res.status(400).render('admin/venue-settings', {
        formValues: readRawFormValues(req.body),
        error: req.uploadError,
        saved: false,
        login: req.session.admin.login,
        role: req.session.admin.role,
        venueSlug: req.session.admin.venueSlug,
      });
    }

    const parsed = venueSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('admin/venue-settings', {
        formValues: readRawFormValues(req.body),
        error: t(parsed.error.issues[0].message),
        saved: false,
        login: req.session.admin.login,
        role: req.session.admin.role,
        venueSlug: req.session.admin.venueSlug,
      });
    }

    const venueId = req.session.admin.venueId;
    const venue = await venueModel.findById(venueId);

    const logoFile = req.files && req.files.logo && req.files.logo[0];
    const coverFile = req.files && req.files.cover && req.files.cover[0];

    let logo = null;
    let cover = null;
    try {
      if (logoFile) logo = await saveItemPhoto(venueId, logoFile.buffer);
      if (coverFile) cover = await saveItemPhoto(venueId, coverFile.buffer);
    } catch (err) {
      if (err.message === 'IMAGE_PROCESSING_FAILED') {
        return res.status(400).render('admin/venue-settings', {
          formValues: readRawFormValues(req.body),
          error: t('items.errorImageProcessing'),
          saved: false,
          login: req.session.admin.login,
          role: req.session.admin.role,
          venueSlug: req.session.admin.venueSlug,
        });
      }
      throw err;
    }

    await venueModel.updateSettings(venueId, {
      phone: parsed.data.phone,
      address: parsed.data.address,
      address2gisUrl: parsed.data.address_2gis_url,
      wifiSsid: parsed.data.wifi_ssid,
      wifiPassword: parsed.data.wifi_password,
      instagramUrl: parsed.data.instagram_url,
      telegramUrl: parsed.data.telegram_url,
      workingHours: parsed.data.working_hours,
      descriptionRu: parsed.data.description_ru,
      descriptionUz: parsed.data.description_uz,
      descriptionEn: parsed.data.description_en,
      cuisineRu: parsed.data.cuisine_ru,
      cuisineUz: parsed.data.cuisine_uz,
      cuisineEn: parsed.data.cuisine_en,
      categoryLabelRu: parsed.data.category_label_ru,
      categoryLabelUz: parsed.data.category_label_uz,
      categoryLabelEn: parsed.data.category_label_en,
      districtRu: parsed.data.district_ru,
      districtUz: parsed.data.district_uz,
      districtEn: parsed.data.district_en,
      email: parsed.data.email,
      enabledLangs: parsed.data.enabled_langs,
      langDefault: parsed.data.lang_default,
      logoUrl: logo ? logo.photoUrl : null,
      logoThumbUrl: logo ? logo.photoThumbUrl : null,
      coverUrl: cover ? cover.photoUrl : null,
      coverThumbUrl: cover ? cover.photoThumbUrl : null,
    });

    if (logo) await deleteItemPhotoFiles(venue.logo_url, venue.logo_thumb_url);
    if (cover) await deleteItemPhotoFiles(venue.cover_url, venue.cover_thumb_url);

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'update',
      entityType: 'venue',
      entityId: venueId,
      details: {
        phone: parsed.data.phone,
        address: parsed.data.address,
        address_2gis_url: parsed.data.address_2gis_url,
        instagram_url: parsed.data.instagram_url,
        telegram_url: parsed.data.telegram_url,
        working_hours: parsed.data.working_hours,
        email: parsed.data.email,
        enabled_langs: parsed.data.enabled_langs,
        lang_default: parsed.data.lang_default,
      },
    });

    await pgNotify.publishMenuChange(venueId);
    await renderForm(req, res, 200, null, true);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
