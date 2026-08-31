const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const siteSettingsCache = require('../services/siteSettingsCache');
const paymentClaimModel = require('../models/paymentClaimModel');
const payment = require('../services/payment');
const notificationModel = require('../models/notificationModel');
const { saveReceiptPhoto } = require('../services/photoService');
const { claimSchema, CLAIM_MONTHS } = require('../validators/paymentClaimValidators');
const { calculatePeriodPrice, PERIOD_DISCOUNTS } = require('../config/constants');
const env = require('../config/env');
const { GRACE_DAYS } = require('../services/venueLifecycle');
const { todayUTC, parseDateOnly, diffDaysUTC } = require('../utils/dateOnly');

router.use(requireAuth, requireRole(['venue_admin']));

function buildPeriodOptions() {
  return CLAIM_MONTHS.map((months) => ({
    months, price: calculatePeriodPrice(months), discountPercent: PERIOD_DISCOUNTS[months] || 0,
  }));
}

// "История платежей" на этом экране — payment_claims (дата/период/сумма/статус/комментарий,
// ровно те колонки, что просит промт), а не таблица payments: у payments нет ни статуса, ни
// периода, она — лог ручных продлений суперадминистратором (своя история на /superadmin/venues/:id),
// самому заведению эта таблица не показывается.
async function renderPage(req, res, { status = 200, error = null, venue, payerNoteValue = '', selectedMonths = 3 } = {}) {
  const [pendingClaim, claims, siteSettings] = await Promise.all([
    paymentClaimModel.findPendingByVenue(venue.id),
    paymentClaimModel.listByVenue(venue.id),
    siteSettingsCache.get(),
  ]);

  const daysLeft = venue.subscription_until
    ? diffDaysUTC(parseDateOnly(venue.subscription_until), todayUTC())
    : null;
  const graceDaysLeft = venue.status === 'grace' && daysLeft !== null
    ? Math.max(0, GRACE_DAYS - Math.abs(daysLeft))
    : null;

  res.status(status).render('admin/subscription', {
    login: req.session.admin.login,
    role: req.session.admin.role,
    venue,
    daysLeft,
    graceDaysLeft,
    siteSettings,
    blocked: req.query.blocked === 'suspended',
    pendingClaim,
    claims,
    periodOptions: buildPeriodOptions(),
    selectedMonths,
    error,
    formValues: { payer_note: payerNoteValue },
  });
}

// Полная версия — период/реквизиты/чек/"Я оплатил"/история (промт 1.4). Минимальная версия
// (только статус и дата) была в промте 1.3, эта её заменяет полностью на той же странице.
router.get('/', async (req, res, next) => {
  try {
    const venueResult = await pool.query('SELECT * FROM venues WHERE id = $1', [req.session.admin.venueId]);
    const venue = venueResult.rows[0];
    if (!venue) {
      return res.status(500).render('errors/500');
    }
    await renderPage(req, res, { venue });
  } catch (err) {
    next(err);
  }
});

router.post('/claim', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const venueResult = await pool.query('SELECT * FROM venues WHERE id = $1', [venueId]);
    const venue = venueResult.rows[0];
    // draft — подписки как таковой ещё нет (заведение не опубликовано), платить не за что;
    // archived разрешаем: реальная оплата — законный путь вернуться, см. venueLifecycle.
    if (!venue || venue.status === 'draft') {
      return res.redirect('/admin');
    }

    const existingPending = await paymentClaimModel.findPendingByVenue(venueId);
    if (existingPending) {
      return res.redirect('/admin/subscription');
    }

    const selectedMonths = Number(req.body.months) || 3;
    const payerNoteValue = typeof req.body.payer_note === 'string' ? req.body.payer_note : '';

    if (req.uploadError) {
      return renderPage(req, res, { status: 400, error: req.uploadError, venue, payerNoteValue, selectedMonths });
    }

    const { t } = res.locals;
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderPage(req, res, {
        status: 400, error: t(parsed.error.issues[0].message), venue, payerNoteValue, selectedMonths,
      });
    }

    let receiptUrl = null;
    if (req.file) {
      receiptUrl = await saveReceiptPhoto(venueId, req.file.buffer);
    }

    const amount = calculatePeriodPrice(parsed.data.months);
    const claim = await paymentClaimModel.create(null, {
      venueId,
      months: parsed.data.months,
      amount,
      currency: 'UZS',
      payerNote: parsed.data.payer_note,
      receiptUrl,
    });

    for (const ownerId of env.OWNER_TELEGRAM_IDS) {
      await notificationModel.enqueue(null, {
        channel: 'telegram',
        recipient: String(ownerId),
        template: 'payment_claim_created',
        payload: {
          id: claim.id,
          venue_name: venue.name,
          months: claim.months,
          amount: claim.amount,
          currency: claim.currency,
          payer_note: claim.payer_note,
          receipt_url: claim.receipt_url,
        },
        lang: 'ru',
      });
    }

    res.redirect('/admin/subscription');
  } catch (err) {
    next(err);
  }
});

router.post('/cancel-claim', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const claimId = Number(req.body.claim_id);
    if (Number.isInteger(claimId) && claimId > 0) {
      await payment.cancelClaim(claimId, venueId);
    }
    res.redirect('/admin/subscription');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
