const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const { logAction } = require('../models/adminActionLogModel');
const { venueSettingsSchema } = require('../validators/venueSettingsValidators');
const menuCache = require('../services/menuCache');

router.use(requireAuth, requireRole(['venue_admin']));

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
  };
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

router.post('/', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const parsed = venueSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('admin/venue-settings', {
        formValues: {
          phone: typeof req.body.phone === 'string' ? req.body.phone : '',
          address: typeof req.body.address === 'string' ? req.body.address : '',
          address_2gis_url: typeof req.body.address_2gis_url === 'string' ? req.body.address_2gis_url : '',
          wifi_ssid: typeof req.body.wifi_ssid === 'string' ? req.body.wifi_ssid : '',
          wifi_password: typeof req.body.wifi_password === 'string' ? req.body.wifi_password : '',
          instagram_url: typeof req.body.instagram_url === 'string' ? req.body.instagram_url : '',
          telegram_url: typeof req.body.telegram_url === 'string' ? req.body.telegram_url : '',
          working_hours: typeof req.body.working_hours === 'string' ? req.body.working_hours : '',
        },
        error: t(parsed.error.issues[0].message),
        saved: false,
        login: req.session.admin.login,
        role: req.session.admin.role,
        venueSlug: req.session.admin.venueSlug,
      });
    }

    const venueId = req.session.admin.venueId;
    await venueModel.updateSettings(venueId, {
      phone: parsed.data.phone,
      address: parsed.data.address,
      address2gisUrl: parsed.data.address_2gis_url,
      wifiSsid: parsed.data.wifi_ssid,
      wifiPassword: parsed.data.wifi_password,
      instagramUrl: parsed.data.instagram_url,
      telegramUrl: parsed.data.telegram_url,
      workingHours: parsed.data.working_hours,
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
