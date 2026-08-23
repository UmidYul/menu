const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');

const COOKIE_NAME = 'admin_lang';

// Язык интерфейса админки выбирается администратором вручную и хранится в cookie
// (не связан с языком меню конкретного заведения).
function adminLocale(req, res, next) {
  const cookieLang = req.cookies && req.cookies[COOKIE_NAME];
  const lang = SUPPORTED_LANGS.includes(cookieLang) ? cookieLang : DEFAULT_LANG;
  res.locals.lang = lang;
  res.locals.t = (key, params) => t(key, lang, params);
  next();
}

module.exports = { adminLocale, COOKIE_NAME };
