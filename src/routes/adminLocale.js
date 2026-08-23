const express = require('express');

const router = express.Router();
const { SUPPORTED_LANGS } = require('../i18n');
const { COOKIE_NAME } = require('../middlewares/adminLocale');

// Переключение языка интерфейса админки. GET осознанно (это выбор отображения,
// не изменение данных), редиректит обратно на страницу, с которой пришли.
router.get('/lang', (req, res) => {
  const { lang, redirect } = req.query;

  if (SUPPORTED_LANGS.includes(lang)) {
    res.cookie(COOKIE_NAME, lang, { httpOnly: false, sameSite: 'lax' });
  }

  const safeRedirect = typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')
    ? redirect
    : '/admin/login';

  res.redirect(safeRedirect);
});

module.exports = router;
