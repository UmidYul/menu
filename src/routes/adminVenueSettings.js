const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const { logAction } = require('../models/adminActionLogModel');
const { venueSettingsSchema, DAYS } = require('../validators/venueSettingsValidators');
const menuCache = require('../services/menuCache');

router.use(requireAuth, requireRole(['venue_admin']));

function emptyWorkingHours() {
  const obj = {};
  DAYS.forEach((day) => {
    obj[day] = '';
  });
  return obj;
}

async function renderForm(req, res, status, error, saved) {
  const venue = await venueModel.findById(req.session.admin.venueId);
  res.status(status || 200).render('admin/venue-settings', {
    formValues: {
      phone: venue.phone || '',
      address: venue.address || '',
      address_2gis_url: venue.address_2gis_url || '',
      instagram_url: venue.instagram_url || '',
      telegram_url: venue.telegram_url || '',
      working_hours: { ...emptyWorkingHours(), ...(venue.working_hours || {}) },
    },
    days: DAYS,
    error: error || null,
    saved: !!saved,
    login: req.session.admin.login,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await renderForm(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const parsed = venueSettingsSchema.safeParse({
      ...req.body,
      working_hours: req.body.working_hours || {},
    });
    if (!parsed.success) {
      return res.status(400).render('admin/venue-settings', {
        formValues: {
          phone: typeof req.body.phone === 'string' ? req.body.phone : '',
          address: typeof req.body.address === 'string' ? req.body.address : '',
          address_2gis_url: typeof req.body.address_2gis_url === 'string' ? req.body.address_2gis_url : '',
          instagram_url: typeof req.body.instagram_url === 'string' ? req.body.instagram_url : '',
          telegram_url: typeof req.body.telegram_url === 'string' ? req.body.telegram_url : '',
          working_hours: { ...emptyWorkingHours(), ...(req.body.working_hours || {}) },
        },
        days: DAYS,
        error: t(parsed.error.issues[0].message),
        saved: false,
        login: req.session.admin.login,
      });
    }

    const venueId = req.session.admin.venueId;
    await venueModel.updateSettings(venueId, {
      phone: parsed.data.phone,
      address: parsed.data.address,
      address2gisUrl: parsed.data.address_2gis_url,
      workingHours: parsed.data.working_hours,
      instagramUrl: parsed.data.instagram_url,
      telegramUrl: parsed.data.telegram_url,
    });

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
      },
    });

    menuCache.invalidateVenue(req.session.admin.venueSlug);
    await renderForm(req, res, 200, null, true);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
