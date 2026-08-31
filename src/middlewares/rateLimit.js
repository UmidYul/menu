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

module.exports = { loginLimiter, applyLimiter };
