const adminSessionHashModel = require('../models/adminSessionHashModel');
const { sessionHash } = require('../utils/sessionHash');
const { todayUTC, formatDateOnly } = require('../utils/dateOnly');

// Промт 3.2. Тот же session_hash, что и у гостя на публичной странице (IP+UA+суточная соль) —
// пишем его сюда на каждый запрос venue_admin, чтобы аналитика при включённом
// venues.exclude_owner_views могла отличить "зашёл я сам, проверяя меню" от настоящего гостя.
// Fire-and-forget: ни при каких обстоятельствах не должно задержать или сломать сам запрос —
// ошибка здесь только в лог, next() вызывается независимо от результата записи.
function recordOwnerSessionHash(req) {
  if (!req.session || !req.session.admin) return;
  // Промт 3.6: признак «это заходил свой, а не гость» теперь определяется ролью В АКТИВНОМ
  // заведении, а не типом аккаунта. Официант (staff) сюда по-прежнему не попадает: аналитика
  // исключает просмотры владельца, а не всего персонала.
  const venueRole = req.session.admin.venueRole;
  if (venueRole !== 'owner' && venueRole !== 'manager') return;
  const venueId = req.session.admin.venueId;
  if (!venueId) return;
  const hash = sessionHash(req.ip, req.headers['user-agent']);
  adminSessionHashModel.recordIfMissing(venueId, hash, formatDateOnly(todayUTC())).catch((err) => {
    console.error('auth: не удалось записать session_hash владельца', err);
  });
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.redirect('/admin/login');
  }
  recordOwnerSessionHash(req);
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.admin) {
      return res.redirect('/admin/login');
    }
    if (!roles.includes(req.session.admin.role)) {
      return res.status(403).render('errors/403');
    }
    recordOwnerSessionHash(req);
    next();
  };
}

// Промт 3.6. Роль внутри заведения — то, чем на самом деле определяется доступ в кабинете.
// requireRole выше проверяет ТИП АККАУНТА (superadmin против пользователя заведения) и остаётся
// только для суперадминки; всё, что работает с данными заведения, проверяется здесь.
//
// Роль берётся из req.session.admin.venueRole, который на каждый запрос выставляет
// middlewares/activeVenue.js по свежим данным из admin_venues, — не из сессии как таковой.
// Разница принципиальная: сессия живёт неделю, а отзыв доступа должен действовать сразу.
//
// Раскладка ролей (промт 3.6, раздел 3):
//   owner   — всё, включая подписку, оплату и управление сотрудниками;
//   manager — всё, кроме перечисленного выше;
//   staff   — только стоп-лист и вызовы официанта (плюс белый список маршрутов, промт 3.5).
function requireVenueRole(roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.admin) {
      return res.redirect('/admin/login');
    }
    // Суперадмин в кабинет заведения не ходит: у него нет ни активного заведения, ни роли в нём.
    // Отдельная ветка нужна, чтобы он получал понятный 403, а не «роль undefined».
    const venueRole = req.session.admin.venueRole;
    if (!venueRole || !roles.includes(venueRole)) {
      return res.status(403).render('errors/403');
    }
    recordOwnerSessionHash(req);
    return next();
  };
}

// Промт 1.5: пока не сменит одноразовый пароль, венью-админ не должен попасть никуда, кроме
// самой формы смены (и логаута). Middleware, а не проверка в шаблоне — иначе прямой POST на
// любой другой роут в обход интерфейса всё равно сработал бы. Ставится ТОЛЬКО на маунты с
// реальным содержимым админки в app.js — /admin/login и /admin/logout через него не проходят
// (иначе пользователь с флагом не смог бы даже выйти), /admin/password — тоже (это и есть выход).
function redirectIfMustChangePassword(req, res, next) {
  if (req.session && req.session.admin && req.session.admin.mustChangePassword) {
    return res.redirect('/admin/password');
  }
  next();
}

module.exports = { requireAuth, requireRole, requireVenueRole, redirectIfMustChangePassword };
