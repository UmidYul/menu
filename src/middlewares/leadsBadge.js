const leadModel = require('../models/leadModel');
const paymentClaimModel = require('../models/paymentClaimModel');

// Бейджи "новые заявки"/"заявки на оплату" в сайдбаре суперадминки — считаем на каждый запрос
// под /superadmin/*, а не только на своих страницах, чтобы число было видно на любой странице
// суперадминки (заведения, логи, настройки), а не только открыв сами заявки.
async function leadsBadge(req, res, next) {
  try {
    const [leadsNewCount, paymentClaimsPendingCount] = await Promise.all([
      leadModel.countNew(),
      paymentClaimModel.countPending(),
    ]);
    res.locals.leadsNewCount = leadsNewCount;
    res.locals.paymentClaimsPendingCount = paymentClaimsPendingCount;
  } catch (err) {
    res.locals.leadsNewCount = 0;
    res.locals.paymentClaimsPendingCount = 0;
  }
  next();
}

module.exports = { leadsBadge };
