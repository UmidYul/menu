const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const { findByLogin } = require('../models/adminModel');
const { loginSchema } = require('../validators/authValidators');
const { loginLimiter } = require('../middlewares/rateLimit');
const { requireAuth } = require('../middlewares/auth');

router.get('/login', (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: null, login: '' });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('admin/login', {
        error: 'Заполните логин и пароль',
        login: typeof req.body.login === 'string' ? req.body.login : '',
      });
    }
    const { login, password } = parsed.data;

    const admin = await findByLogin(login);
    if (!admin) {
      return res.status(401).render('admin/login', {
        error: 'Неверный логин или пароль',
        login,
      });
    }

    const passwordMatches = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatches) {
      return res.status(401).render('admin/login', {
        error: 'Неверный логин или пароль',
        login,
      });
    }

    if (admin.role !== 'superadmin' && admin.venue_is_active === false) {
      return res.status(403).render('admin/login', {
        error: 'Заведение временно отключено. Обратитесь к администратору сервиса.',
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
