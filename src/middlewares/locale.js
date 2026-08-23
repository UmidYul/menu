const { t, DEFAULT_LANG } = require('../i18n');

// Даёт каждому шаблону безопасный дефолт (res.locals.t/lang), чтобы общие вьюхи
// (errors/500 и т.п.) не падали, если более специфичный middleware ветки
// (adminLocale, публичное меню) ещё не выставил свой язык.
function defaultLocale(req, res, next) {
  res.locals.lang = DEFAULT_LANG;
  res.locals.t = (key, params) => t(key, DEFAULT_LANG, params);
  next();
}

module.exports = defaultLocale;
