const express = require('express');

const router = express.Router();
const { requireAuth } = require('../middlewares/auth');
const adminVenueModel = require('../models/adminVenueModel');

// Промт 3.6. Переключение активного заведения.
//
// requireVenueRole здесь намеренно НЕТ: переключаться вправе любой, у кого есть доступ хотя бы
// к двум заведениям, включая официанта, работающего в двух точках сети. Право проверяется тем
// единственным, что здесь имеет значение, — наличием строки в admin_venues.
router.use(requireAuth);

// Куда вернуться после переключения. Промт: «затем редирект на тот же раздел».
// Берём ТОЛЬКО путь и только свой, из тела формы: Referer подделывается, а произвольная строка
// в Location — это открытый редирект. Роль в новом заведении может оказаться меньше (manager
// в одном, staff в другом), поэтому раздел, на который нет прав, всё равно отсеется своим
// requireVenueRole — здесь достаточно не пустить наружу.
function safeRedirect(raw) {
  if (typeof raw !== 'string') return '/admin';
  // Только абсолютный путь внутри /admin. '//evil.com' и '/\\evil.com' браузер трактует как
  // внешний адрес, поэтому второй символ проверяется отдельно.
  if (!raw.startsWith('/admin') || raw.startsWith('//') || raw.startsWith('/\\')) return '/admin';
  return raw;
}

router.post('/', async (req, res, next) => {
  try {
    const venueId = Number(req.body.venue_id);
    const back = safeRedirect(req.body.redirect);

    if (!Number.isInteger(venueId) || venueId <= 0) return res.redirect(back);

    // Проверка права — запросом к БД, а не сверкой со списком в сессии: список в сессии
    // обновляется тем же resolveActiveVenue, но доверять ему как источнику права нельзя.
    const access = await adminVenueModel.findAccess(req.session.admin.id, venueId);
    if (!access) return res.status(403).render('errors/403');

    req.session.admin.venueId = venueId;
    req.session.admin.venueRole = access.role;
    // Остальное (slug, список, роль) перевыставит resolveActiveVenue на следующем же запросе
    // из свежих данных — здесь достаточно записать выбор.

    return req.session.save((err) => {
      if (err) return next(err);
      return res.redirect(back);
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
