function requireAuth(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.redirect('/admin/login');
  }
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
    next();
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

module.exports = { requireAuth, requireRole, redirectIfMustChangePassword };
