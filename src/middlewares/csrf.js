const crypto = require('crypto');

const TOKEN_BYTES = 32;
// methodOverride уже переписал req.method в PATCH/DELETE к этому моменту (мидлварь стоит раньше
// в цепочке) — сверяемся с финальным методом, а не с тем, что реально пришло по HTTP.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Простая защита от CSRF для админки/суперадминки: токен привязан к сессии (не к cookie сам по
// себе — session-cookie у нас httpOnly, так что токен нельзя ни прочитать, ни подставить со
// стороннего сайта иначе как через саму форму), кладётся в res.locals для шаблонов и сверяется
// на каждый небезопасный метод. Без него SameSite=lax на cookie сессии — единственная линия
// защиты, а это поведение браузера по умолчанию, а не гарантия уровня приложения.
// Токен нужен не только самому csrfProtection: страницу «нет доступа ни к одному заведению»
// (промт 3.6) рисует middleware, который стоит РАНЬШЕ него в цепочке, а форма выхода на ней
// всё равно должна работать. Отдельная функция вместо дублирования этих трёх строк.
function ensureCsrfToken(req, res) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  }
  if (res) res.locals.csrfToken = req.session.csrfToken;
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  if (!req.session) return next();

  ensureCsrfToken(req, res);

  if (SAFE_METHODS.has(req.method)) return next();

  const submitted = req.body && req.body._csrf;
  const expected = req.session.csrfToken;
  const valid = typeof submitted === 'string'
    && submitted.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));

  if (!valid) {
    return res.status(403).render('errors/403');
  }
  next();
}

module.exports = { csrfProtection, ensureCsrfToken };
