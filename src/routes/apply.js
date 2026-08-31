const crypto = require('crypto');
const express = require('express');

const router = express.Router();
const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const { applyFormSchema, VENUE_TYPES } = require('../validators/leadValidators');
const { applyLimiter } = require('../middlewares/rateLimit');
const leadModel = require('../models/leadModel');
const notificationModel = require('../models/notificationModel');
const siteSettingsCache = require('../services/siteSettingsCache');
const env = require('../config/env');
const { SERVICE_NAME } = require('../config/constants');

const LANG_COOKIE = 'site_lang';
// Бот-заполнители обычно проходят форму мгновенно — реальному человеку нужно хотя бы
// прочитать поля и что-то напечатать. 3с — тот же порог, что и в антифлуде бота (см. промт 1.1).
const MIN_FILL_TIME_MS = 3000;

function resolveLang(req, res) {
  if (SUPPORTED_LANGS.includes(req.query.lang)) {
    res.cookie(LANG_COOKIE, req.query.lang, { httpOnly: false, sameSite: 'lax' });
    return req.query.lang;
  }
  if (SUPPORTED_LANGS.includes(req.cookies && req.cookies[LANG_COOKIE])) {
    return req.cookies[LANG_COOKIE];
  }
  return DEFAULT_LANG;
}

// Псевдонимизация IP для leads.ip_hash: соль включает дату, так что хеш одного и того же IP
// меняется день ото дня — нельзя по хешу сопоставить активность за разные сутки, но в рамках
// одних суток одинаковые IP всё ещё дают одинаковый хеш (пригодно для анализа паттернов спама).
// SESSION_SECRET уже обязателен в env.js — отдельный секрет под это заводить незачем.
function hashIp(ip) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${env.SESSION_SECRET}:${day}:${ip}`).digest('hex');
}

async function renderForm(req, res, lang, { status = 200, error = null, values = {} } = {}) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const siteSettings = await siteSettingsCache.get();
  res.status(status).render('public/apply', {
    lang,
    t: (key, params) => t(key, lang, params),
    serviceName: SERVICE_NAME,
    baseUrl,
    canonicalUrl: `${baseUrl}/apply`,
    ogLocale: lang === 'uz' ? 'uz_UZ' : 'ru_RU',
    siteSettings,
    venueTypes: VENUE_TYPES,
    error,
    values,
    formRenderedAt: Date.now(),
  });
}

router.get('/', async (req, res, next) => {
  try {
    const lang = resolveLang(req, res);
    const error = req.query.rate_limited === '1' ? t('apply.errorRateLimited', lang) : null;
    await renderForm(req, res, lang, { error });
  } catch (err) {
    next(err);
  }
});

router.post('/', applyLimiter, async (req, res, next) => {
  const lang = resolveLang(req, res);
  try {
    // Honeypot ("website" — скрытое от людей CSS, но не от ботов, заполняющих все поля формы)
    // и минимальное время заполнения — заявка тихо "успешна" (редирект на thanks, как при
    // настоящей отправке), но никакой записи в leads не создаётся и никто не уведомляется.
    // Показывать ботам отдельную ошибку нет смысла — они на неё не реагируют, а вот обычную
    // страницу успеха проще всего спутать с настоящей, если разбор всё же автоматический.
    const filledInMs = Date.now() - Number(req.body.form_rendered_at);
    const honeypotTripped = typeof req.body.website === 'string' && req.body.website.length > 0;
    if (honeypotTripped || !Number.isFinite(filledInMs) || filledInMs < MIN_FILL_TIME_MS) {
      console.warn('apply: похоже на спам (honeypot/тайминг), заявка отброшена без создания записи', {
        ip: req.ip, honeypotTripped, filledInMs,
      });
      return res.redirect('/apply/thanks');
    }

    const parsed = applyFormSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderForm(req, res, lang, {
        status: 400,
        error: t(parsed.error.issues[0].message, lang),
        values: req.body,
      });
    }

    const { venue_name: venueName, city, venue_type: venueType, contact_name: contactName, phone, email, comment } = parsed.data;

    const lead = await leadModel.create(null, {
      source: 'web',
      telegramId: null,
      telegramUsername: null,
      contactName,
      phone,
      email,
      venueName,
      city,
      venueType,
      comment,
      ipHash: hashIp(req.ip),
      userAgent: req.get('user-agent') || null,
    });

    // Веб-процесс не держит живого соединения с Bot API (в отличие от bot/scenes/applyLead.js,
    // где заявка приходит прямо в сценарии) — уведомление владельцам и на почту идёт через
    // очередь notifications, как и остальные исходящие из веб-процесса (см. промт 0.1).
    for (const ownerId of env.OWNER_TELEGRAM_IDS) {
      await notificationModel.enqueue(null, {
        channel: 'telegram', recipient: String(ownerId), template: 'lead_created', payload: lead, lang: 'ru',
      });
    }
    const siteSettings = await siteSettingsCache.get();
    if (siteSettings && siteSettings.email) {
      await notificationModel.enqueue(null, {
        channel: 'email', recipient: siteSettings.email, template: 'lead_created', payload: lead, lang: 'ru',
      });
    }

    res.redirect('/apply/thanks');
  } catch (err) {
    next(err);
  }
});

router.get('/thanks', async (req, res, next) => {
  try {
    const lang = resolveLang(req, res);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const siteSettings = await siteSettingsCache.get();
    res.render('public/apply-thanks', {
      lang,
      t: (key, params) => t(key, lang, params),
      serviceName: SERVICE_NAME,
      baseUrl,
      canonicalUrl: `${baseUrl}/apply/thanks`,
      ogLocale: lang === 'uz' ? 'uz_UZ' : 'ru_RU',
      siteSettings,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
