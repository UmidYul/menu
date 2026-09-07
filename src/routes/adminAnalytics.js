const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const { logAction } = require('../models/adminActionLogModel');
const analyticsDashboard = require('../services/analyticsDashboard');
const analyticsExport = require('../services/analyticsExport');

// period уже РАЗРЕШЁН (resolvePeriod откатывает мусор к разумному дефолту) — эта строка нужна
// только для того, чтобы кнопка экспорта и скрытые поля переключателей вели на тот же диапазон,
// что сейчас на экране, а не сбрасывали его на "последние 7 дней" при каждом клике.
function buildPeriodQuery(period) {
  if (period.preset === 'custom') {
    return `period=custom&from=${period.from.toISOString().slice(0, 10)}&to=${period.to.toISOString().slice(0, 10)}`;
  }
  return `period=${period.preset}`;
}

// В отличие от /admin/categories, /admin/items и т.п. здесь намеренно нет venueStatusGate —
// аналитика read-only (не редактирует меню) и должна оставаться доступной даже suspended/
// archived заведению: это как раз тот момент, когда владельцу может быть особенно важно
// посмотреть, что было ДО приостановки, чтобы решить, платить ли за возобновление.
router.use(requireAuth, requireRole(['venue_admin']));

router.get('/', async (req, res, next) => {
  try {
    const venue = await venueModel.findById(req.session.admin.venueId);
    if (!venue) return res.status(500).render('errors/500');

    const { t, lang } = res.locals;
    const dashboard = await analyticsDashboard.buildDashboard(venue, req.query, lang, t);

    res.render('admin/analytics', {
      venue,
      dashboard,
      periodQuery: buildPeriodQuery(dashboard.period),
      login: req.session.admin.login,
      role: req.session.admin.role,
      venueSlug: venue.slug,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/export.xlsx', async (req, res, next) => {
  try {
    const venue = await venueModel.findById(req.session.admin.venueId);
    if (!venue) return res.status(500).render('errors/500');

    const { t, lang } = res.locals;
    const dashboard = await analyticsDashboard.buildDashboard(venue, req.query, lang, t);
    const buffer = await analyticsExport.buildWorkbook(venue, dashboard, t);

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="analytics-${venue.slug}-${dashboard.period.preset}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Оба переключателя ниже — тихий PRG на саму страницу аналитики с сохранением текущего периода
// в query (?period=... из скрытого поля формы), чтобы переключение не сбрасывало выбранный
// диапазон дат.
router.post('/toggle-exclude-owner', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const updated = await venueModel.toggleExcludeOwnerViews(venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'venue',
      entityId: venueId, details: { field: 'exclude_owner_views', value: updated.exclude_owner_views },
    });
    res.redirect(`/admin/analytics${req.body.returnQuery || ''}`);
  } catch (err) {
    next(err);
  }
});

router.post('/toggle-weekly-summary', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const updated = await venueModel.toggleWeeklySummaryEnabled(venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'venue',
      entityId: venueId, details: { field: 'weekly_summary_enabled', value: updated.weekly_summary_enabled },
    });
    res.redirect(`/admin/analytics${req.body.returnQuery || ''}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
