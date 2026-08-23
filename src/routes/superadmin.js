const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const adminModel = require('../models/adminModel');
const { logAction } = require('../models/adminActionLogModel');
const { createVenueSchema } = require('../validators/venueValidators');
const menuCache = require('../services/menuCache');

router.use(requireAuth, requireRole(['superadmin']));

router.get('/venues', async (req, res, next) => {
  try {
    const venues = await venueModel.listAll();
    res.render('superadmin/venues', {
      venues,
      login: req.session.admin.login,
      error: null,
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
      error,
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

module.exports = router;
