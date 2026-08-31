const path = require('path');
const ejs = require('ejs');
const { Markup } = require('telegraf');
const { t } = require('../../src/i18n');
const siteSettingsCache = require('../../src/services/siteSettingsCache');
const { escapeHtml } = require('../../src/utils/escapeHtml');
const { buildLeadCardMessage } = require('../lib/leadNotify');
const env = require('../../src/config/env');

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

  // Напоминания о подписке (промт 1.3, bot/worker/scheduler.js) — только email: заведение пока
  // никак не привязано к конкретному Telegram-чату (эта привязка — промт 1.5), так что
  // venueLifecycle.notifyVenue сейчас может доставить их только на email заведения. Как только
  // 1.5 добавит привязку, туда же добавляется telegram()-рендер — сама эта запись менять не надо.
  subscription_reminder_7d: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('subscription-reminder-7d'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.subscriptionReminder7dSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.subscriptionReminder7dText', { venueName: payload.venue_name, until: payload.until }),
      };
    },
  },

  subscription_reminder_3d: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('subscription-reminder-3d'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.subscriptionReminder3dSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.subscriptionReminder3dText', { venueName: payload.venue_name, until: payload.until }),
      };
    },
  },

  subscription_reminder_1d: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('subscription-reminder-1d'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.subscriptionReminder1dSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.subscriptionReminder1dText', { venueName: payload.venue_name, until: payload.until }),
      };
    },
  },

  subscription_expiring_today: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('subscription-expiring-today'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.subscriptionExpiringTodaySubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.subscriptionExpiringTodayText', { venueName: payload.venue_name }),
      };
    },
  },

  subscription_grace_warning: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('subscription-grace-warning'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.subscriptionGraceWarningSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.subscriptionGraceWarningText', { venueName: payload.venue_name, days: payload.days }),
      };
    },
  },

  venue_suspended: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('venue-suspended'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.venueSuspendedSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.venueSuspendedText', { venueName: payload.venue_name }),
      };
    },
  },

  subscription_archive_warning: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('subscription-archive-warning'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.subscriptionArchiveWarningSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.subscriptionArchiveWarningText', { venueName: payload.venue_name, days: payload.days }),
      };
    },
  },

  // Владельцу сервиса, только Telegram (OWNER_TELEGRAM_ID всегда доступен, email не нужен).
  venue_suspended_owner: {
    telegram(payload, lang) {
      return { text: t('bot.templates.venueSuspendedOwnerTelegram', lang, { venueName: payload.venue_name, venueId: payload.venue_id }) };
    },
  },

  manual_contact_needed: {
    telegram(payload, lang) {
      return { text: t('bot.templates.manualContactNeededTelegram', lang, { venueName: payload.venue_name, venueId: payload.venue_id, reason: payload.reason }) };
    },
  },

  venue_published: {
    telegram(payload, lang) {
      return { text: t('bot.templates.venuePublishedTelegram', lang, { venueName: payload.venue_name, venueId: payload.venue_id }) };
    },
  },

  // Заявка на оплату создаётся только с веб-экрана /admin/subscription (в отличие от лидов,
  // у payment_claims нет пути "создано прямо в процессе бота") — карточка владельцу сервиса
  // всегда идёт через очередь, отдельного direct-send-функции не нужно, см. README.
  payment_claim_created: {
    telegram(payload, lang) {
      const buttons = [
        [
          Markup.button.callback(t('bot.paymentClaim.btnConfirm', lang), `claim:confirm:${payload.id}`),
          Markup.button.callback(t('bot.paymentClaim.btnReject', lang), `claim:reject:${payload.id}`),
        ],
      ];
      const receiptLine = payload.receipt_url
        ? `\n${t('bot.paymentClaim.receiptLine', lang, { url: `${env.APP_BASE_URL}${payload.receipt_url}` })}`
        : '';
      const text = t('bot.paymentClaim.card', lang, {
        venueName: payload.venue_name,
        months: payload.months,
        amount: Number(payload.amount).toLocaleString('ru-RU'),
        currency: payload.currency,
        note: payload.payer_note || t('bot.apply.summaryEmpty', lang),
      }) + receiptLine;
      return { text, extra: Markup.inlineKeyboard(buttons) };
    },
  },

  // Отклонение заявки на оплату — только email заведению (та же причина, что и у напоминаний
  // о подписке в промте 1.3: нет привязки Telegram к конкретному заведению до промта 1.5).
  payment_claim_rejected: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('payment-claim-rejected'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.paymentClaimRejectedSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.paymentClaimRejectedText', { venueName: payload.venue_name, reason: payload.reason }),
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
