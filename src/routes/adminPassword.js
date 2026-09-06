const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const { requireAuth } = require('../middlewares/auth');
const adminModel = require('../models/adminModel');
const venueModel = require('../models/venueModel');
const venueTelegramLinkModel = require('../models/venueTelegramLinkModel');
const telegramLink = require('../services/telegramLink');
const { applyNewPassword } = require('../services/passwordChange');
const { buildChangePasswordSchema } = require('../validators/authValidators');
const env = require('../config/env');

router.use(requireAuth);

async function renderPage(req, res, { status = 200, error = null, success = null } = {}) {
  const { role, login, venueId } = req.session.admin;

  let venue = null;
  let telegramLinkState = null;
  if (role === 'venue_admin') {
    venue = await venueModel.findById(venueId);
    const activeCode = await venueTelegramLinkModel.findActiveByAdmin(req.session.admin.id);
    const admin = await adminModel.findById(req.session.admin.id);
    telegramLinkState = {
      linked: Boolean(admin.telegram_id),
      code: activeCode ? activeCode.code : null,
      botLink: activeCode && env.BOT_USERNAME ? `https://t.me/${env.BOT_USERNAME}?start=link_${activeCode.code}` : null,
      botConfigured: Boolean(env.BOT_USERNAME),
    };
  }

  res.status(status).render('admin/password', {
    login,
    role,
    venue,
    telegramLinkState,
    error,
    success,
  });
}

router.get('/', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const success = req.query.changed === '1' ? t('login.passwordChanged') : null;
    await renderPage(req, res, { success });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const admin = await adminModel.findById(req.session.admin.id);
    const parsed = buildChangePasswordSchema(admin.login).safeParse(req.body);
    if (!parsed.success) {
      return renderPage(req, res, { status: 400, error: t(parsed.error.issues[0].message) });
    }

    const currentMatches = await bcrypt.compare(parsed.data.current_password, admin.password_hash);
    if (!currentMatches) {
      return renderPage(req, res, { status: 401, error: t('login.errorCurrentPasswordWrong') });
    }

    await applyNewPassword(admin, parsed.data.new_password, { currentSessionId: req.sessionID });
    req.session.admin.mustChangePassword = false;

    res.redirect('/admin/password?changed=1');
  } catch (err) {
    next(err);
  }
});

router.post('/telegram-link/generate', async (req, res, next) => {
  try {
    if (req.session.admin.role !== 'venue_admin') return res.redirect('/admin/password');
    await venueTelegramLinkModel.create(req.session.admin.venueId, req.session.admin.id);
    res.redirect('/admin/password');
  } catch (err) {
    next(err);
  }
});

router.post('/telegram-link/unlink', async (req, res, next) => {
  try {
    if (req.session.admin.role !== 'venue_admin') return res.redirect('/admin/password');
    await telegramLink.unlink(req.session.admin.id, req.session.admin.venueId);
    res.redirect('/admin/password');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
