const rateLimit = require('express-rate-limit');
const { sessionHashFromRequest } = require('../services/eventTracking');

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

// Промт 3.2, /api/events: 500 событий на session_hash в час — не на IP (общий IP-лимитер ниже
// уже есть отдельно) и не на venue, потому что реальный лимит на злоупотребление — это "один
// гость с одного устройства/браузера", а session_hash как раз и есть этот гость (тот же IP+UA,
// та же формула, что и у самих событий — см. src/services/eventTracking.js). 204 без тела —
// это фоновый sendBeacon, у которого никто не читает ответ.
const eventsBySessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => sessionHashFromRequest(req),
  handler: (req, res) => {
    res.status(204).end();
  },
});

// Общий IP-лимит поверх session-лимита — подстраховка на случай подмены User-Agent на каждый
// запрос (тогда session_hash каждый раз новый, и лимитер выше его не поймает).
const eventsByIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(204).end();
  },
});

// Промт 2.4: «Не больше 30 заказов с одного IP в час (заведение с общим Wi-Fi — не занижай)».
// Лимит по session_hash (3 заказа в час) живёт не здесь, а в самом роуте — он считается по БД,
// чтобы переживать перезапуск процесса и не расходиться между инстансами.
const ordersByIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Считаем только успешные попытки создания: отбитые пересчётом/закрытым заведением заказы
  // не должны съедать лимит гостя, который ни в чём не виноват.
  skipFailedRequests: true,
  handler: (req, res) => {
    res.status(429).json({ error: 'too_many_orders_ip' });
  },
});

module.exports = {
  ordersByIpLimiter,
  loginLimiter,
  loginByAccountLimiter,
  applyLimiter,
  forgotPasswordIpLimiter,
  forgotPasswordAccountLimiter,
  eventsBySessionLimiter,
  eventsByIpLimiter,
};
