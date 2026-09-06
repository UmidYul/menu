const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('admin/login', {
      error: res.locals.t('login.errorRateLimited'),
      login: req.body.login || '',
    });
  },
});

// Второй лимитер на тот же /admin/login — по конкретному логину, а не по IP (промт 1.5, п.5):
// без него перебор пароля одного аккаунта с разных IP/через прокси упирается только в общий
// IP-лимит выше, который его не видит. Ключ — сырой текст поля login "как есть" (без поиска
// admin по нему) — это осознанно, поиск в БД внутри keyGenerator на каждый запрос был бы лишней
// нагрузкой, а сам лимит не более чем ещё один барьер поверх задержки/аудита в adminAuth.js.
const loginByAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (typeof req.body.login === 'string' ? req.body.login.trim().toLowerCase() : ''),
  handler: (req, res) => {
    res.status(429).render('admin/login', {
      error: res.locals.t('login.errorRateLimited'),
      login: req.body.login || '',
    });
  },
});

// Редирект на GET вместо прямого рендера — apply.js сам решает, что показать (полная страница
// с siteSettings/nav/footer через res.render там сложнее дублировать здесь без циклической
// зависимости на роут). GET-обработчик проверяет ?rate_limited=1 и выводит apply.errorRateLimited.
const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.redirect('/apply?rate_limited=1');
  },
});

// /admin/forgot: тот же приём, что у логина — IP-лимит и лимит по конкретному введённому
// значению (email/логин) вместе, промт 1.5 требует оба (3/аккаунт/час, 10/IP/час). Ответ формы
// всегда одинаковый независимо от лимита, чтобы 429 сам не стал способом проверить, какие
// логины существуют — оба хендлера рендерят ТУ ЖЕ "письмо отправлено, если аккаунт есть" страницу.
const forgotPasswordIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.render('admin/forgot', { submitted: true, error: null, identifier: '' });
  },
});

const forgotPasswordAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (typeof req.body.identifier === 'string' ? req.body.identifier.trim().toLowerCase() : ''),
  handler: (req, res) => {
    res.render('admin/forgot', { submitted: true, error: null, identifier: '' });
  },
});

module.exports = {
  loginLimiter,
  loginByAccountLimiter,
  applyLimiter,
  forgotPasswordIpLimiter,
  forgotPasswordAccountLimiter,
};
