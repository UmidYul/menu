const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const env = require('../config/env');
const venueModel = require('../models/venueModel');
const groupLinkModel = require('../models/venueTelegramGroupLinkModel');
const { logAction } = require('../models/adminActionLogModel');
const { minOrderAmountSchema } = require('../validators/orderValidators');

// venueStatusGate здесь намеренно нет — по той же причине, что и на /admin/analytics: это не
// редактирование меню. Приостановленное заведение должно иметь возможность хотя бы посмотреть
// и выключить приём заказов, а не упереться в редирект.
router.use(requireAuth, requireRole(['venue_admin']));

async function renderPage(req, res, status, error) {
  const venueId = req.session.admin.venueId;
  const [venue, activeCode] = await Promise.all([
    venueModel.findById(venueId),
    groupLinkModel.findActiveByVenue(venueId),
  ]);

  res.status(status || 200).render('admin/orders-settings', {
    venue,
    linkCode: activeCode ? activeCode.code : null,
    botConfigured: env.botConfigured,
    botUsername: env.BOT_USERNAME,
    error: error || null,
    login: req.session.admin.login,
    role: req.session.admin.role,
    venueSlug: venue.slug,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await renderPage(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/generate-code', async (req, res, next) => {
  try {
    await groupLinkModel.create(req.session.admin.venueId, req.session.admin.id);
    res.redirect('/admin/orders-settings');
  } catch (err) {
    next(err);
  }
});

router.post('/unlink', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    await venueModel.unlinkTelegramChat(venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'venue',
      entityId: venueId, details: { field: 'telegram_chat_id', value: null },
    });
    res.redirect('/admin/orders-settings');
  } catch (err) {
    next(err);
  }
});

router.post('/toggle-orders', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const updated = await venueModel.toggleOrdersEnabled(venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'venue',
      entityId: venueId, details: { field: 'orders_enabled', value: updated.orders_enabled },
    });
    res.redirect('/admin/orders-settings');
  } catch (err) {
    next(err);
  }
});

router.post('/min-amount', async (req, res, next) => {
  try {
    const { t } = res.locals;
    const parsed = minOrderAmountSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderPage(req, res, 422, t(parsed.error.issues[0].message));
    }

    const venueId = req.session.admin.venueId;
    const updated = await venueModel.setMinOrderAmount(venueId, parsed.data.min_order_amount);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'venue',
      entityId: venueId, details: { field: 'min_order_amount', value: updated.min_order_amount },
    });
    return res.redirect('/admin/orders-settings');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
