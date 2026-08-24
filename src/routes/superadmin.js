const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const adminModel = require('../models/adminModel');
const { logAction, listRecent } = require('../models/adminActionLogModel');
const { createVenueSchema } = require('../validators/venueValidators');
const menuCache = require('../services/menuCache');

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
