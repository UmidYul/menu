const path = require('path');
const ejs = require('ejs');
const { t } = require('../../src/i18n');
const siteSettingsCache = require('../../src/services/siteSettingsCache');
const { escapeHtml } = require('../../src/utils/escapeHtml');
const { buildLeadCardMessage } = require('../lib/leadNotify');

function emailPath(name) {
  return path.join(__dirname, `../../src/views/emails/${name}.ejs`);
}

// Реестр "template из notifications.template" -> рендер контента на канал. Неизвестный
// template — вызывающий код (воркер) должен сам решить, что делать (см. worker/notifications.js:
// такая запись помечается 'failed' сразу, без ретраев — рендерить всё равно нечего).
const TEMPLATES = {
  payment_recorded: {
    telegram(payload, lang) {
      return {
        text: t('bot.templates.paymentRecordedTelegram', lang, {
          venueName: payload.venue_name,
          amount: payload.amount,
          currency: payload.currency,
          until: payload.extends_until,
        }),
      };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('payment-recorded'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.paymentRecordedSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.paymentRecordedText', {
          venueName: payload.venue_name,
          amount: payload.amount,
          currency: payload.currency,
          until: payload.extends_until,
        }),
      };
    },
  },

  // Карточка новой заявки владельцу сервиса — только для заявок с сайта (payload несёт данные
  // заявки, включая id для кнопок Одобрить/Отклонить). Заявки из бота уведомляют владельца
  // напрямую, без очереди — bot/lib/leadNotify.js:notifyOwnersNewLead, см. комментарий там.
  lead_created: {
    telegram(payload, lang) {
      return buildLeadCardMessage(payload, lang);
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('lead-created'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.leadCreatedSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.leadCreatedText', { venueName: payload.venue_name, phone: payload.phone }),
      };
    },
  },

  lead_approved: {
    telegram(payload, lang) {
      return {
        text: t('bot.templates.leadApprovedTelegram', lang, {
          venueName: payload.venue_name,
          adminLogin: payload.admin_login,
          adminPassword: payload.admin_password,
        }),
      };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('lead-approved'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.leadApprovedSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.leadApprovedTelegram', {
          venueName: payload.venue_name,
          adminLogin: payload.admin_login,
          adminPassword: payload.admin_password,
        }),
      };
    },
  },

  lead_rejected: {
    telegram(payload, lang) {
      return {
        text: t('bot.templates.leadRejectedTelegram', lang, { venueName: payload.venue_name, reason: payload.reason }),
      };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('lead-rejected'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.leadRejectedSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.leadRejectedTelegram', { venueName: payload.venue_name, reason: payload.reason }),
      };
    },
  },
};

async function renderNotification(channel, template, payload, lang) {
  const entry = TEMPLATES[template];
  if (!entry || !entry[channel]) return null;
  return entry[channel](payload, lang);
}

module.exports = { renderNotification };
