const express = require('express');

const router = express.Router();
const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const {
  SERVICE_NAME, PRICE_MONTH_UZS, PRICE_MONTH_OLD_UZS, FREE_TRIAL_MONTHS, DISCOUNT_PERCENT,
} = require('../config/constants');
const { PERIOD_MONTHS } = require('../validators/paymentValidators');
const { formatPriceUZS } = require('../utils/formatPrice');
const siteSettingsCache = require('../services/siteSettingsCache');

const LANG_COOKIE = 'site_lang';

router.get('/', async (req, res, next) => {
  try {
    let lang;
    if (SUPPORTED_LANGS.includes(req.query.lang)) {
      lang = req.query.lang;
      res.cookie(LANG_COOKIE, lang, { httpOnly: false, sameSite: 'lax' });
    } else if (SUPPORTED_LANGS.includes(req.cookies && req.cookies[LANG_COOKIE])) {
      lang = req.cookies[LANG_COOKIE];
    } else {
      lang = DEFAULT_LANG;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const siteSettings = await siteSettingsCache.get();

    const pricing = {
      priceMonth: formatPriceUZS(PRICE_MONTH_UZS, lang),
      priceMonthOld: formatPriceUZS(PRICE_MONTH_OLD_UZS, lang),
      priceMonthRaw: PRICE_MONTH_UZS,
      discountPercent: DISCOUNT_PERCENT,
      freeTrialMonths: FREE_TRIAL_MONTHS,
      // Скидка за предоплату на 3/6 месяцев считается от уже существующих периодов
      // подписки (PERIOD_MONTHS), а не от отдельного списка, заведённого только для лендинга.
      periods: PERIOD_MONTHS
        .filter((months) => months !== '1')
        .map((months) => ({ months, total: formatPriceUZS(PRICE_MONTH_UZS * Number(months), lang) })),
    };

    res.render('public/landing', {
      lang,
      t: (key, params) => t(key, lang, params),
      serviceName: SERVICE_NAME,
      baseUrl,
      canonicalUrl: `${baseUrl}/`,
      ogLocale: lang === 'uz' ? 'uz_UZ' : 'ru_RU',
      siteSettings,
      pricing,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
