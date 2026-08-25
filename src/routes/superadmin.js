const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const adminModel = require('../models/adminModel');
const paymentModel = require('../models/paymentModel');
const { logAction, listRecent } = require('../models/adminActionLogModel');
const { createVenueSchema } = require('../validators/venueValidators');
const { extendSubscriptionSchema, PAYMENT_METHODS, PERIOD_MONTHS } = require('../validators/paymentValidators');
const menuCache = require('../services/menuCache');
const {
  todayUTC,
  parseDateOnly,
  formatDateOnly,
  isValidDateOnly,
  addMonthsUTC,
  diffDaysUTC,
} = require('../utils/dateOnly');

const SUBSCRIPTION_EXPIRING_SOON_DAYS = 7;

function computeSubscriptionStatus(subscriptionUntil) {
  if (!subscriptionUntil) return 'overdue';
  const daysLeft = diffDaysUTC(parseDateOnly(subscriptionUntil), todayUTC());
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= SUBSCRIPTION_EXPIRING_SOON_DAYS) return 'expiring';
  return 'active';
}

router.use(requireAuth, requireRole(['superadmin']));

router.get('/venues', async (req, res, next) => {
  try {
    const venues = await venueModel.listAll();
    res.render('superadmin/venues', {
      venues,
      login: req.session.admin.login,
      role: req.session.admin.role,
      error: null,
      formTarget: null,
      formValues: { slug: '', name: '', lang_default: 'ru', admin_login: '' },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/venues', async (req, res, next) => {
  const { t } = res.locals;
  const renderWithError = async (status, error) => {
    const venues = await venueModel.listAll();
    res.status(status).render('superadmin/venues', {
      venues,
      login: req.session.admin.login,
      role: req.session.admin.role,
      error,
      formTarget: 'add',
      formValues: {
        slug: typeof req.body.slug === 'string' ? req.body.slug : '',
        name: typeof req.body.name === 'string' ? req.body.name : '',
        lang_default: req.body.lang_default === 'uz' ? 'uz' : 'ru',
        admin_login: typeof req.body.admin_login === 'string' ? req.body.admin_login : '',
      },
    });
  };

  try {
    const parsed = createVenueSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderWithError(400, t(parsed.error.issues[0].message));
    }
    const { slug, name, lang_default: langDefault, admin_login: adminLogin, admin_password: adminPassword } =
      parsed.data;

    const existingVenue = await venueModel.findBySlug(slug);
    if (existingVenue) {
      return renderWithError(409, t('superadmin.errorSlugTaken', { slug }));
    }

    const existingAdmin = await adminModel.findByLogin(adminLogin);
    if (existingAdmin) {
      return renderWithError(409, t('superadmin.errorLoginTaken', { login: adminLogin }));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const venue = await venueModel.create(client, { slug, name, langDefault });
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      const admin = await adminModel.create(client, {
        venueId: venue.id,
        login: adminLogin,
        passwordHash,
        role: 'venue_admin',
      });

      await logAction(client, {
        adminId: req.session.admin.id,
        venueId: venue.id,
        actionType: 'create',
        entityType: 'venue',
        entityId: venue.id,
        details: { slug: venue.slug, name: venue.name, admin_login: admin.login },
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return renderWithError(409, t('superadmin.errorGenericConflict'));
      }
      throw err;
    } finally {
      client.release();
    }

    res.redirect('/superadmin/venues');
  } catch (err) {
    next(err);
  }
});

router.post('/venues/:id/toggle-active', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).render('errors/message', {
        title: t('superadmin.notFoundInvalidId'),
        message: t('superadmin.notFoundInvalidIdMessage'),
        backUrl: '/superadmin/venues',
      });
    }

    const venue = await venueModel.toggleActive(id);
    if (!venue) {
      return res.status(404).render('errors/message', {
        title: t('superadmin.notFoundVenue'),
        message: t('superadmin.notFoundVenueMessage'),
        backUrl: '/superadmin/venues',
      });
    }

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: venue.id,
      actionType: 'update',
      entityType: 'venue',
      entityId: venue.id,
      details: { is_active: venue.is_active },
    });

    res.redirect('/superadmin/venues');
  } catch (err) {
    next(err);
  }
});

router.post('/venues/:id/toggle-powered-by', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).render('errors/message', {
        title: t('superadmin.notFoundInvalidId'),
        message: t('superadmin.notFoundInvalidIdMessage'),
        backUrl: '/superadmin/venues',
      });
    }

    const venue = await venueModel.toggleShowPoweredBy(id);
    if (!venue) {
      return res.status(404).render('errors/message', {
        title: t('superadmin.notFoundVenue'),
        message: t('superadmin.notFoundVenueMessage'),
        backUrl: '/superadmin/venues',
      });
    }

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: venue.id,
      actionType: 'update',
      entityType: 'venue',
      entityId: venue.id,
      details: { show_powered_by: venue.show_powered_by },
    });

    menuCache.invalidateVenue(venue.slug);
    res.redirect('/superadmin/venues');
  } catch (err) {
    next(err);
  }
});

function buildExtendFormValues(body) {
  return {
    amount: typeof body.amount === 'string' ? body.amount : '',
    method: PAYMENT_METHODS.includes(body.method) ? body.method : 'cash',
    comment: typeof body.comment === 'string' ? body.comment : '',
    paid_at: typeof body.paid_at === 'string' && body.paid_at ? body.paid_at : formatDateOnly(todayUTC()),
    period_mode: body.period_mode === 'manual' ? 'manual' : 'preset',
    period_months: PERIOD_MONTHS.includes(body.period_months) ? body.period_months : '1',
    manual_until: typeof body.manual_until === 'string' ? body.manual_until : '',
  };
}

router.get('/venues/:id', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).render('errors/message', {
        title: t('superadmin.notFoundInvalidId'),
        message: t('superadmin.notFoundInvalidIdMessage'),
        backUrl: '/superadmin/venues',
      });
    }

    const venue = await venueModel.findById(id);
    if (!venue) {
      return res.status(404).render('errors/message', {
        title: t('superadmin.notFoundVenue'),
        message: t('superadmin.notFoundVenueMessage'),
        backUrl: '/superadmin/venues',
      });
    }

    const payments = await paymentModel.listByVenue(id);

    res.render('superadmin/venue-detail', {
      venue,
      payments,
      subscriptionStatus: computeSubscriptionStatus(venue.subscription_until),
      login: req.session.admin.login,
      role: req.session.admin.role,
      error: null,
      formValues: buildExtendFormValues({}),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/venues/:id/extend', async (req, res, next) => {
  const { t } = res.locals;

  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).render('errors/message', {
        title: t('superadmin.notFoundInvalidId'),
        message: t('superadmin.notFoundInvalidIdMessage'),
        backUrl: '/superadmin/venues',
      });
    }

    const venue = await venueModel.findById(id);
    if (!venue) {
      return res.status(404).render('errors/message', {
        title: t('superadmin.notFoundVenue'),
        message: t('superadmin.notFoundVenueMessage'),
        backUrl: '/superadmin/venues',
      });
    }

    const renderWithError = async (status, error) => {
      const payments = await paymentModel.listByVenue(id);
      res.status(status).render('superadmin/venue-detail', {
        venue,
        payments,
        subscriptionStatus: computeSubscriptionStatus(venue.subscription_until),
        login: req.session.admin.login,
        role: req.session.admin.role,
        error,
        formValues: buildExtendFormValues(req.body),
      });
    };

    const parsed = extendSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderWithError(400, t(parsed.error.issues[0].message));
    }
    const {
      amount,
      method,
      comment,
      paid_at: paidAtStr,
      period_mode: periodMode,
      period_months: periodMonths,
      manual_until: manualUntilStr,
    } = parsed.data;

    if (!isValidDateOnly(paidAtStr)) {
      return renderWithError(400, t('superadmin.errorPaidAtInvalid'));
    }
    const paidAt = parseDateOnly(paidAtStr);
    if (diffDaysUTC(paidAt, todayUTC()) > 0) {
      return renderWithError(400, t('superadmin.errorPaidAtFuture'));
    }

    let extendsUntil;
    if (periodMode === 'preset') {
      const today = todayUTC();
      const currentUntil = venue.subscription_until ? parseDateOnly(venue.subscription_until) : null;
      const base = currentUntil && diffDaysUTC(currentUntil, today) > 0 ? currentUntil : today;
      extendsUntil = addMonthsUTC(base, Number(periodMonths));
    } else {
      if (!isValidDateOnly(manualUntilStr)) {
        return renderWithError(400, t('superadmin.errorManualUntilInvalid'));
      }
      extendsUntil = parseDateOnly(manualUntilStr);
    }
    const extendsUntilStr = formatDateOnly(extendsUntil);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const payment = await paymentModel.create(client, {
        venueId: id,
        amount,
        currency: 'UZS',
        method,
        comment,
        paidAt: paidAtStr,
        extendsUntil: extendsUntilStr,
        createdBy: req.session.admin.id,
      });

      await venueModel.updateSubscriptionUntil(client, id, extendsUntilStr);

      await logAction(client, {
        adminId: req.session.admin.id,
        venueId: id,
        actionType: 'create',
        entityType: 'payment',
        entityId: payment.id,
        details: {
          amount: payment.amount,
          currency: payment.currency,
          method: payment.method,
          paid_at: paidAtStr,
          extends_until: extendsUntilStr,
        },
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.redirect(`/superadmin/venues/${id}`);
  } catch (err) {
    next(err);
  }
});

const LOG_ACTION_TYPES = ['create', 'update', 'delete', 'toggle_availability'];
const ACTION_LABEL_KEYS = {
  create: 'superadmin.actionCreate',
  update: 'superadmin.actionUpdate',
  delete: 'superadmin.actionDelete',
  toggle_availability: 'superadmin.actionToggleAvailability',
};
const ENTITY_LABEL_KEYS = {
  item: 'superadmin.entityItem',
  category: 'superadmin.entityCategory',
  venue: 'superadmin.entityVenue',
  admin: 'superadmin.entityAdmin',
  payment: 'superadmin.entityPayment',
};

router.get('/logs', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const venues = await venueModel.listAll();

    const venueId = Number(req.query.venue_id);
    const actionType = LOG_ACTION_TYPES.includes(req.query.action_type) ? req.query.action_type : '';
    const page = Number.isInteger(Number(req.query.page)) && Number(req.query.page) > 0 ? Number(req.query.page) : 1;

    const logs = await listRecent({
      venueId: Number.isInteger(venueId) && venueId > 0 ? venueId : null,
      actionType: actionType || null,
      page,
    });
    logs.rows = logs.rows.map((row) => ({
      ...row,
      actionLabel: t(ACTION_LABEL_KEYS[row.action_type] || row.action_type),
      entityLabel: t(ENTITY_LABEL_KEYS[row.entity_type] || row.entity_type),
    }));

    res.render('superadmin/logs', {
      logs,
      venues,
      actionTypeOptions: LOG_ACTION_TYPES.map((type) => ({ value: type, label: t(ACTION_LABEL_KEYS[type]) })),
      filterVenueId: req.query.venue_id || '',
      filterActionType: actionType,
      login: req.session.admin.login,
      role: req.session.admin.role,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
