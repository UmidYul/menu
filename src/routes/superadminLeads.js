const express = require('express');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const leadModel = require('../models/leadModel');
const venueModel = require('../models/venueModel');
const adminModel = require('../models/adminModel');
const leadApproval = require('../services/leadApproval');
const { logAction } = require('../models/adminActionLogModel');
const { createVenueSchema } = require('../validators/venueValidators');
const { rejectReasonSchema } = require('../validators/leadValidators');

router.use(requireAuth, requireRole(['superadmin']));

const LEAD_STATUSES = ['new', 'contacted', 'approved', 'rejected', 'spam'];
// Одобрить/отклонить/спам можно только пока заявка не обработана — то же правило, что и
// у быстрых кнопок бота (bot/handlers/leadActions.js), здесь просто дублируется на веб-сторону.
const ACTIONABLE_STATUSES = ['new', 'contacted'];

router.get('/', async (req, res, next) => {
  try {
    const status = LEAD_STATUSES.includes(req.query.status) ? req.query.status : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const page = Number.isInteger(Number(req.query.page)) && Number(req.query.page) > 0 ? Number(req.query.page) : 1;

    const leads = await leadModel.list({ status: status || null, search: search || null, page });

    res.render('superadmin/leads', {
      leads,
      filterStatus: status,
      filterSearch: search,
      login: req.session.admin.login,
      role: req.session.admin.role,
    });
  } catch (err) {
    next(err);
  }
});

async function loadLeadOr404(req, res) {
  const id = Number(req.params.id);
  const { t } = res.locals;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).render('errors/message', {
      title: t('superadmin.notFoundInvalidId'),
      message: t('superadmin.notFoundInvalidIdMessage'),
      backUrl: '/superadmin/leads',
    });
    return null;
  }
  const lead = await leadModel.findById(id);
  if (!lead) {
    res.status(404).render('errors/message', {
      title: t('superadmin.notFoundVenue'),
      message: t('superadmin.notFoundVenueMessage'),
      backUrl: '/superadmin/leads',
    });
    return null;
  }
  return lead;
}

function buildApproveFormValues(defaults) {
  return {
    slug: defaults.slug,
    name: defaults.name,
    lang_default: defaults.langDefault,
    admin_login: defaults.adminLogin,
    admin_password: defaults.adminPassword,
  };
}

async function renderDetail(req, res, lead, { approveError = null, approveFormValues = null, rejectError = null } = {}) {
  const similarLeads = await leadModel.findOtherActiveByPhone(lead.phone, lead.id);
  const defaults = ACTIONABLE_STATUSES.includes(lead.status) ? await leadApproval.buildApprovalDefaults(lead) : null;

  res.render('superadmin/lead-detail', {
    lead,
    similarLeads,
    isActionable: ACTIONABLE_STATUSES.includes(lead.status),
    login: req.session.admin.login,
    role: req.session.admin.role,
    approveError,
    approveFormValues: approveFormValues || (defaults ? buildApproveFormValues(defaults) : null),
    rejectError,
  });
}

router.get('/:id', async (req, res, next) => {
  try {
    const lead = await loadLeadOr404(req, res);
    if (!lead) return;
    await renderDetail(req, res, lead);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/contact', async (req, res, next) => {
  try {
    const lead = await loadLeadOr404(req, res);
    if (!lead) return;
    if (!ACTIONABLE_STATUSES.includes(lead.status)) return res.redirect(`/superadmin/leads/${lead.id}`);

    await leadModel.markContacted(lead.id, req.session.admin.id);
    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: null,
      actionType: 'update',
      entityType: 'lead',
      entityId: lead.id,
      details: { status: 'contacted' },
    });
    res.redirect(`/superadmin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const lead = await loadLeadOr404(req, res);
    if (!lead) return;
    if (!ACTIONABLE_STATUSES.includes(lead.status)) return res.redirect(`/superadmin/leads/${lead.id}`);

    const parsed = createVenueSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderDetail(req, res, lead, {
        approveError: t(parsed.error.issues[0].message),
        approveFormValues: {
          slug: typeof req.body.slug === 'string' ? req.body.slug : '',
          name: typeof req.body.name === 'string' ? req.body.name : '',
          lang_default: req.body.lang_default === 'uz' ? 'uz' : 'ru',
          admin_login: typeof req.body.admin_login === 'string' ? req.body.admin_login : '',
          admin_password: '',
        },
      });
    }
    const { slug, name, lang_default: langDefault, admin_login: adminLogin, admin_password: adminPassword } = parsed.data;

    const existingVenue = await venueModel.findBySlug(slug);
    if (existingVenue) {
      return renderDetail(req, res, lead, {
        approveError: t('superadmin.errorSlugTaken', { slug }),
        approveFormValues: { slug, name, lang_default: langDefault, admin_login: adminLogin, admin_password: '' },
      });
    }
    const existingAdmin = await adminModel.findByLogin(adminLogin);
    if (existingAdmin) {
      return renderDetail(req, res, lead, {
        approveError: t('superadmin.errorLoginTaken', { login: adminLogin }),
        approveFormValues: { slug, name, lang_default: langDefault, admin_login: adminLogin, admin_password: '' },
      });
    }

    const { venue } = await leadApproval.approveLead(lead, {
      slug, name, langDefault, adminLogin, adminPassword, processedBy: req.session.admin.id,
    });
    res.redirect(`/superadmin/venues/${venue.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reject', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const lead = await loadLeadOr404(req, res);
    if (!lead) return;
    if (!ACTIONABLE_STATUSES.includes(lead.status)) return res.redirect(`/superadmin/leads/${lead.id}`);

    const parsed = rejectReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderDetail(req, res, lead, { rejectError: t(parsed.error.issues[0].message) });
    }

    await leadApproval.rejectLead(lead, { reason: parsed.data.reason, processedBy: req.session.admin.id });
    res.redirect(`/superadmin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/spam', async (req, res, next) => {
  try {
    const lead = await loadLeadOr404(req, res);
    if (!lead) return;
    if (!ACTIONABLE_STATUSES.includes(lead.status)) return res.redirect(`/superadmin/leads/${lead.id}`);

    await leadModel.markSpam(lead.id, req.session.admin.id);
    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: null,
      actionType: 'update',
      entityType: 'lead',
      entityId: lead.id,
      details: { status: 'spam' },
    });
    res.redirect(`/superadmin/leads/${lead.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
