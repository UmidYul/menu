const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const paymentClaimModel = require('../models/paymentClaimModel');
const payment = require('../services/payment');
const { claimRejectSchema } = require('../validators/paymentClaimValidators');

router.use(requireAuth, requireRole(['superadmin']));

const CLAIM_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

router.get('/', async (req, res, next) => {
  try {
    const status = CLAIM_STATUSES.includes(req.query.status) ? req.query.status : '';
    const page = Number.isInteger(Number(req.query.page)) && Number(req.query.page) > 0 ? Number(req.query.page) : 1;

    const claims = await paymentClaimModel.list({ status: status || null, page });

    res.render('superadmin/payment-claims', {
      claims,
      filterStatus: status,
      login: req.session.admin.login,
      role: req.session.admin.role,
    });
  } catch (err) {
    next(err);
  }
});

async function loadClaimOr404(req, res) {
  const id = Number(req.params.id);
  const { t } = res.locals;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).render('errors/message', {
      title: t('superadmin.notFoundInvalidId'),
      message: t('superadmin.notFoundInvalidIdMessage'),
      backUrl: '/superadmin/payment-claims',
    });
    return null;
  }
  const claim = await paymentClaimModel.findById(id);
  if (!claim) {
    res.status(404).render('errors/message', {
      title: t('superadmin.notFoundVenue'),
      message: t('superadmin.notFoundVenueMessage'),
      backUrl: '/superadmin/payment-claims',
    });
    return null;
  }
  return claim;
}

router.get('/:id', async (req, res, next) => {
  try {
    const claim = await loadClaimOr404(req, res);
    if (!claim) return;

    const venueResult = await pool.query('SELECT id, name, slug FROM venues WHERE id = $1', [claim.venue_id]);
    const venue = venueResult.rows[0];

    res.render('superadmin/payment-claim-detail', {
      claim,
      venue,
      login: req.session.admin.login,
      role: req.session.admin.role,
      rejectError: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/confirm', async (req, res, next) => {
  try {
    const claim = await loadClaimOr404(req, res);
    if (!claim) return;

    await payment.confirmPayment(claim.id, { adminId: req.session.admin.id });
    res.redirect(`/superadmin/payment-claims/${claim.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reject', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const claim = await loadClaimOr404(req, res);
    if (!claim) return;

    const parsed = claimRejectSchema.safeParse(req.body);
    if (!parsed.success) {
      const venueResult = await pool.query('SELECT id, name, slug FROM venues WHERE id = $1', [claim.venue_id]);
      return res.status(400).render('superadmin/payment-claim-detail', {
        claim, venue: venueResult.rows[0],
        login: req.session.admin.login, role: req.session.admin.role,
        rejectError: t(parsed.error.issues[0].message),
      });
    }

    await payment.rejectClaim(claim.id, { adminId: req.session.admin.id }, parsed.data.reason);
    res.redirect(`/superadmin/payment-claims/${claim.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
