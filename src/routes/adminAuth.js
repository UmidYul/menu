const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const { findByLogin } = require('../models/adminModel');
const { loginSchema } = require('../validators/authValidators');
const { loginLimiter } = require('../middlewares/rateLimit');
const { requireAuth } = require('../middlewares/auth');

// Хеш-заглушка для bcrypt.compare, когда логин не найден — без неё ветка "нет такого админа"
// возвращается сразу, а ветка "админ есть, пароль неверный" всегда ждёт полный bcrypt.compare
// (~десятки мс). Разница во времени ответа позволяет перебором логинов узнавать, какие из них
// вообще существуют, даже не подбирая пароль. Сравнение с заглушкой всегда занимает то же время,
// что и сравнение с настоящим хешем той же стоимости, — веток с разным таймингом не остаётся.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing-equalization', 10);

router.get('/login', (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: null, login: '' });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  const { t } = res.locals;
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('admin/login', {
        error: t('login.errorEmptyFields'),
        login: typeof req.body.login === 'string' ? req.body.login : '',
      });
    }
    const { login, password } = parsed.data;

    const admin = await findByLogin(login);
    const passwordMatches = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_PASSWORD_HASH);
    if (!admin || !passwordMatches) {
      return res.status(401).render('admin/login', {
        error: t('login.errorInvalidCredentials'),
        login,
      });
    }

    if (admin.is_active === false) {
      return res.status(403).render('admin/login', {
        error: t('login.errorAccountDisabled'),
        login,
      });
    }

    if (admin.role !== 'superadmin' && admin.venue_is_active === false) {
      return res.status(403).render('admin/login', {
        error: t('login.errorVenueDisabled'),
        login,
      });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.admin = {
        id: admin.id,
        login: admin.login,
        role: admin.role,
        venueId: admin.venue_id,
        venueSlug: admin.venue_slug || null,
      };

      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        if (admin.role === 'superadmin') {
          return res.redirect('/superadmin/venues');
        }
        return res.redirect('/admin');
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('qrmenu.sid');
    res.redirect('/admin/login');
  });
});

module.exports = router;
