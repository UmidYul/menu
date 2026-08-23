const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const adminModel = require('../models/adminModel');
const { logAction } = require('../models/adminActionLogModel');
const { staffSchema } = require('../validators/staffValidators');

router.use(requireAuth, requireRole(['venue_admin']));

async function renderList(req, res, status, error, formValues) {
  const venueId = req.session.admin.venueId;
  const staff = await adminModel.listStaffByVenue(venueId);
  res.status(status || 200).render('admin/staff', {
    staff,
    error: error || null,
    formValues: formValues || { login: '' },
    login: req.session.admin.login,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await renderList(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const parsed = staffSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderList(req, res, 400, t(parsed.error.issues[0].message), {
        login: typeof req.body.login === 'string' ? req.body.login : '',
      });
    }

    const existing = await adminModel.findByLogin(parsed.data.login);
    if (existing) {
      return renderList(req, res, 409, t('staff.errorLoginTaken', { login: parsed.data.login }), { login: parsed.data.login });
    }

    const venueId = req.session.admin.venueId;
    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    const staffAdmin = await adminModel.create(pool, {
      venueId,
      login: parsed.data.login,
      passwordHash,
      role: 'staff',
    });

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'create',
      entityType: 'admin',
      entityId: staffAdmin.id,
      details: { login: staffAdmin.login, role: 'staff' },
    });

    res.redirect('/admin/staff');
  } catch (err) {
    if (err.code === '23505') {
      return renderList(req, res, 409, t('staff.errorLoginTaken', { login: req.body.login || '' }));
    }
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).render('errors/message', {
        title: t('staff.notFoundTitle'),
        message: t('staff.notFoundMessage'),
        backUrl: '/admin/staff',
      });
    }

    const staffAdmin = await adminModel.findActiveStaffById(id);
    if (!staffAdmin || staffAdmin.venue_id !== req.session.admin.venueId) {
      return res.status(404).render('errors/message', {
        title: t('staff.notFoundTitle'),
        message: t('staff.notFoundForeignMessage'),
        backUrl: '/admin/staff',
      });
    }

    await adminModel.deactivate(staffAdmin.id);

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'delete',
      entityType: 'admin',
      entityId: staffAdmin.id,
      details: { login: staffAdmin.login, role: 'staff' },
    });

    res.redirect('/admin/staff');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
