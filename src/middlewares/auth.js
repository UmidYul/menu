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

module.exports = { requireAuth, requireRole };
