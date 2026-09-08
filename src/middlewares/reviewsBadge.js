const reviewModel = require('../models/reviewModel');

// Бейдж «непрочитанные отзывы» в сайдбаре заведения (промт 3.3) — тот же приём, что и
// leadsBadge для суперадминки: считаем на каждый запрос под /admin/*, чтобы число было
// видно на любой странице, а не только открыв сам раздел отзывов.
// Считается только для venue_admin: у суперадмина этого пункта в меню нет, а venueId у него
// в сессии отсутствует. Ошибка запроса не должна ронять страницу — бейдж просто не покажется.
async function reviewsBadge(req, res, next) {
  res.locals.reviewsUnreadCount = 0;
  const admin = req.session && req.session.admin;
  if (!admin || admin.role !== 'venue_admin' || !admin.venueId) return next();

  try {
    res.locals.reviewsUnreadCount = await reviewModel.countUnread(admin.venueId);
  } catch (err) {
    res.locals.reviewsUnreadCount = 0;
  }
  return next();
}

module.exports = { reviewsBadge };
