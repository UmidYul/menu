const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const itemModel = require('../models/itemModel');
const venueModel = require('../models/venueModel');
const venuePageViewModel = require('../models/venuePageViewModel');
const onboardingModel = require('../models/onboardingModel');
const onboarding = require('../services/onboarding');
const venueLifecycle = require('../services/venueLifecycle');
const { logAction } = require('../models/adminActionLogModel');
const env = require('../config/env');
const notificationModel = require('../models/notificationModel');
const siteSettingsCache = require('../services/siteSettingsCache');
const { todayUTC, parseDateOnly, diffDaysUTC } = require('../utils/dateOnly');

const RECENT_ITEMS_LIMIT = 5;
const CHECKLIST_COOKIE = 'checklist_collapsed_at';

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

    const [stats, recentItems, publishReadiness, siteSettings, checklistCounts] = await Promise.all([
      venuePageViewModel.getStats(venueId),
      itemModel.listRecentByVenue(venueId, RECENT_ITEMS_LIMIT),
      venue.status === 'draft' ? venueLifecycle.checkPublishReadiness(venue) : null,
      venue.status === 'archived' ? siteSettingsCache.get() : null,
      onboardingModel.getChecklistCounts(venueId),
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

    const checklist = onboarding.buildChecklist(venue, checklistCounts);
    const collapsedAtDoneCount = req.cookies && req.cookies[CHECKLIST_COOKIE] !== undefined
      ? Number(req.cookies[CHECKLIST_COOKIE])
      : null;
    const checklistExpanded = onboarding.isExpandedByDefault(venue, checklist)
      && !onboarding.isCollapsedByCookie(collapsedAtDoneCount, checklist.doneCount);

    res.render('admin/dashboard', {
      login, role, venue, stats, recentItems, publishReadiness, daysLeft, graceDaysLeft, siteSettings,
      checklist, checklistExpanded,
    });
  } catch (err) {
    next(err);
  }
});

// Промт 1.6 — запоминает сворачивание чеклиста куки с doneCount на этот момент (не просто
// булевым флагом): если позже что-то из уже выполненного перестанет быть выполненным,
// текущий doneCount окажется МЕНЬШЕ сохранённого, и onboarding.isCollapsedByCookie разожмёт
// блок заново, даже не читая эту куку как "false" — см. комментарий в src/services/onboarding.js.
router.post('/checklist-collapse', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    const venueResult = await pool.query('SELECT * FROM venues WHERE id = $1', [req.session.admin.venueId]);
    const venue = venueResult.rows[0];
    const counts = await onboardingModel.getChecklistCounts(req.session.admin.venueId);
    const checklist = onboarding.buildChecklist(venue, counts);

    res.cookie(CHECKLIST_COOKIE, String(checklist.doneCount), {
      httpOnly: false, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 365,
    });
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.post('/checklist-expand', requireRole(['venue_admin']), (req, res) => {
  res.clearCookie(CHECKLIST_COOKIE);
  res.redirect('/admin');
});

// Единственный способ увидеть публичную страницу черновика — см. изменения в publicMenu.js
// (показывает draft только владельцу этого же заведения). Помечает пункт чеклиста "Проверить
// меню" и сразу уводит на реальную страницу, отдельного превью-шаблона не заводим.
router.get('/preview-menu', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    const venueResult = await pool.query('SELECT slug FROM venues WHERE id = $1', [req.session.admin.venueId]);
    const venue = venueResult.rows[0];
    if (!venue) return res.redirect('/admin');

    await venueModel.markMenuPreviewed(req.session.admin.venueId);
    res.redirect(`/menu/${venue.slug}`);
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
// ?download=1 — только у кнопки "Скачать" (промт 1.6, чеклист онбординга): обычный <img src>
// превью на дашборде дёргает этот же роут БЕЗ параметра при каждой загрузке страницы, и
// помечать qr_downloaded_at на каждый такой показ было бы неверно — пункт чеклиста должен
// отражать осознанное "скачал", а не "открыл кабинет и увидел картинку".
router.get('/qr.png', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    const venueResult = await pool.query('SELECT slug FROM venues WHERE id = $1', [req.session.admin.venueId]);
    const venue = venueResult.rows[0];
    if (!venue) {
      return res.status(404).end();
    }

    // ?src=qr (промт 3.2) — единственный способ аналитике отличить "отсканировали QR со стола"
    // от обычного перехода по ссылке; выдаётся только в закодированный в PNG URL, ссылка,
    // которую владелец копирует кнопкой "Поделиться" на этой же странице, отдельная и без метки.
    const menuUrl = `${req.protocol}://${req.get('host')}/menu/${venue.slug}?src=qr`;
    const buffer = await QRCode.toBuffer(menuUrl, {
      type: 'png',
      width: 480,
      margin: 1,
      color: { dark: '#27251f', light: '#fffdf8' },
    });

    if (req.query.download === '1') {
      await venueModel.markQrDownloaded(req.session.admin.venueId);
      res.set('Content-Disposition', 'attachment; filename="menu-qr.png"');
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
