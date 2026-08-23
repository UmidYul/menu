const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('admin/login', {
      error: 'Слишком много попыток входа. Попробуйте снова через 15 минут.',
      login: req.body.login || '',
    });
  },
});

module.exports = { loginLimiter };
