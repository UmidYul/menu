const express = require('express');

const router = express.Router();
const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const { SERVICE_NAME } = require('../config/constants');

const LANG_COOKIE = 'site_lang';

router.get('/', (req, res) => {
  let lang;
  if (SUPPORTED_LANGS.includes(req.query.lang)) {
    lang = req.query.lang;
    res.cookie(LANG_COOKIE, lang, { httpOnly: false, sameSite: 'lax' });
  } else if (SUPPORTED_LANGS.includes(req.cookies && req.cookies[LANG_COOKIE])) {
    lang = req.cookies[LANG_COOKIE];
  } else {
    lang = DEFAULT_LANG;
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.render('public/landing', {
    lang,
    t: (key, params) => t(key, lang, params),
    serviceName: SERVICE_NAME,
    baseUrl,
    canonicalUrl: `${baseUrl}/`,
    ogLocale: lang === 'uz' ? 'uz_UZ' : 'ru_RU',
  });
});

module.exports = router;
