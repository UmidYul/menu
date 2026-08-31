const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const itemModel = require('../models/itemModel');
const venuePageViewModel = require('../models/venuePageViewModel');
const venueLifecycle = require('../services/venueLifecycle');
const { logAction } = require('../models/adminActionLogModel');
const env = require('../config/env');
const notificationModel = require('../models/notificationModel');
const siteSettingsCache = require('../services/siteSettingsCache');
const { todayUTC, parseDateOnly, diffDaysUTC } = require('../utils/dateOnly');

const RECENT_ITEMS_LIMIT = 5;

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { role, venueId, login } = req.session.admin;

    if (role === 'superadmin') {
      return res.redirect('/superadmin/venues');
    }

    const venueResult = await pool.query('SELECT * FROM venues WHERE id = $1', [venueId]);
    const venue = venueResult.rows[0];

    if (!venue) {
      return res.status(500).render('errors/500');
    }

    const [stats, recentItems, publishReadiness, siteSettings] = await Promise.all([
      venuePageViewModel.getStats(venueId),
      itemModel.listRecentByVenue(venueId, RECENT_ITEMS_LIMIT),
      venue.status === 'draft' ? venueLifecycle.checkPublishReadiness(venue) : null,
      venue.status === 'archived' ? siteSettingsCache.get() : null,
    ]);

    const daysLeft = venue.subscription_until
      ? diffDaysUTC(parseDateOnly(venue.subscription_until), todayUTC())
      : null;
    // Только для grace: сколько дней осталось до перехода в suspended (GRACE_DAYS - уже прошедшие
    // дни просрочки) — та же арифметика, что venueLifecycle.computeTargetStatus использует для
    // самого перехода, здесь только для текста баннера.
    const graceDaysLeft = venue.status === 'grace' && daysLeft !== null
      ? Math.max(0, venueLifecycle.GRACE_DAYS - Math.abs(daysLeft))
      : null;

    res.render('admin/dashboard', {
      login, role, venue, stats, recentItems, publishReadiness, daysLeft, graceDaysLeft, siteSettings,
    });
  } catch (err) {
    next(err);
  }
});

// Публикация — только из draft, только если чеклист готовности пройден (проверяется ещё раз
// на сервере: чеклист в шаблоне — подсказка, а не единственная защита от "успели убрать
// категорию во второй вкладке, пока эта форма была открыта").
router.post('/publish', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const venueResult = await pool.query('SELECT * FROM venues WHERE id = $1', [venueId]);
    const venue = venueResult.rows[0];
    if (!venue || venue.status !== 'draft') {
      return res.redirect('/admin');
    }

    const readiness = await venueLifecycle.checkPublishReadiness(venue);
    if (!readiness.ready) {
      return res.redirect('/admin');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await venueLifecycle.publishVenue(client, venue, { actorAdminId: req.session.admin.id });

      await logAction(client, {
        adminId: req.session.admin.id,
        venueId,
        actionType: 'update',
        entityType: 'venue',
        entityId: venueId,
        details: { status: 'trial', trial_ends_on: updated.trial_ends_on },
      });

      for (const ownerId of env.OWNER_TELEGRAM_IDS) {
        await notificationModel.enqueue(client, {
          channel: 'telegram',
          recipient: String(ownerId),
          template: 'venue_published',
          payload: { venue_name: venue.name, venue_id: venueId },
          lang: 'ru',
        });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

// Настоящий сканируемый QR-код на публичное меню заведения (генерируется на лету, не хранится).
router.get('/qr.png', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    const venueResult = await pool.query('SELECT slug FROM venues WHERE id = $1', [req.session.admin.venueId]);
    const venue = venueResult.rows[0];
    if (!venue) {
      return res.status(404).end();
    }

    const menuUrl = `${req.protocol}://${req.get('host')}/menu/${venue.slug}`;
    const buffer = await QRCode.toBuffer(menuUrl, {
      type: 'png',
      width: 480,
      margin: 1,
      color: { dark: '#27251f', light: '#fffdf8' },
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
