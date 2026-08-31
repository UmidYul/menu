const leadModel = require('../models/leadModel');

// Бейдж "новые заявки" в сайдбаре суперадминки — считаем на каждый запрос под /superadmin/*,
// а не только на /superadmin/leads, чтобы число было видно на любой странице суперадминки
// (заведения, логи, настройки), а не только открыв сами заявки.
async function leadsBadge(req, res, next) {
  try {
    res.locals.leadsNewCount = await leadModel.countNew();
  } catch (err) {
    res.locals.leadsNewCount = 0;
  }
  next();
}

module.exports = { leadsBadge };
