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

  // Промт 1.5 — выдача первичного доступа ДВУМЯ отдельными уведомлениями (логин+ссылка, затем
  // пароль отдельно). Канал (telegram/email) выбирает вызывающий код (leadApproval.js/
  // superadmin.js) — здесь просто оба рендера на случай любого из двух.
  admin_credentials_login: {
    telegram(payload, lang) {
      return {
        text: t('bot.templates.adminCredentialsLoginTelegram', lang, {
          venueName: payload.venue_name,
          adminLogin: payload.admin_login,
          url: `${env.APP_BASE_URL}/admin/login`,
        }),
      };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const fullPayload = { ...payload, login_url: `${env.APP_BASE_URL}/admin/login` };
      const html = await ejs.renderFile(emailPath('admin-credentials-login'), { payload: fullPayload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.adminCredentialsLoginSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.adminCredentialsLoginTelegram', {
          venueName: payload.venue_name, adminLogin: payload.admin_login, url: `${env.APP_BASE_URL}/admin/login`,
        }),
      };
    },
  },

  admin_credentials_password: {
    telegram(payload, lang) {
      return {
        text: t('bot.templates.adminCredentialsPasswordTelegram', lang, { adminPassword: payload.admin_password }),
      };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('admin-credentials-password'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.adminCredentialsPasswordSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.adminCredentialsPasswordTelegram', { adminPassword: payload.admin_password }),
      };
    },
  },

  admin_password_changed: {
    telegram(payload, lang) {
      return { text: t('bot.templates.adminPasswordChangedTelegram', lang, { login: payload.admin_login }) };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('admin-password-changed'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.adminPasswordChangedSubject'),
        html,
        text: tt('bot.templates.adminPasswordChangedTelegram', { login: payload.admin_login }),
      };
    },
  },

  password_reset_link: {
    telegram(payload, lang) {
      return { text: t('bot.templates.passwordResetLinkTelegram', lang, { login: payload.admin_login, url: payload.reset_url }) };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('password-reset-link'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.passwordResetLinkSubject'),
        html,
        text: tt('bot.templates.passwordResetLinkTelegram', { login: payload.admin_login, url: payload.reset_url }),
      };
    },
  },

  // Уведомление ПРЕЖНЕМУ владельцу привязки при перепривязке того же Telegram-аккаунта к
  // другому admins (edge case промта 1.5) — только email: он больше не управляет этим
  // telegram_id, слать туда уведомление о том, что он его больше не контролирует, бессмысленно.
  admin_telegram_unlinked: {
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('admin-telegram-unlinked'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.adminTelegramUnlinkedSubject'),
        html,
        text: tt('bot.templates.adminTelegramUnlinkedLine1', { login: payload.admin_login }),
      };
    },
  },

  // 10 неудачных входов подряд (промт 1.5, п.5) — идёт через venueLifecycle.notifyVenue,
  // поэтому нужны оба рендера: telegram, если у заведения уже привязан owner_telegram_id,
  // иначе email.
  admin_ten_failed_logins: {
    telegram(payload, lang) {
      return { text: t('bot.templates.adminTenFailedLoginsTelegram', lang, { venueName: payload.venue_name }) };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('admin-ten-failed-logins'), { payload, t: tt, siteSettings, escapeHtml });
      return {
        subject: tt('bot.templates.adminTenFailedLoginsSubject', { venueName: payload.venue_name }),
        html,
        text: tt('bot.templates.adminTenFailedLoginsTelegram', { venueName: payload.venue_name }),
      };
    },
  },

  // Напоминания о подписке (промт 1.3, bot/worker/scheduler.js) — раньше только email, потому
  // что заведение было никак не привязано к Telegram-чату; промт 1.5 добавил привязку
  // (venues.owner_telegram_id), поэтому у всех записей ниже теперь есть и telegram()-рендер —
  // notifyVenue сам выбирает канал (telegram, если привязан, иначе email).
  subscription_reminder_7d: {
    telegram(payload, lang) {
      return { text: t('bot.templates.subscriptionReminder7dText', lang, { venueName: payload.venue_name, until: payload.until }) };
    },
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
    telegram(payload, lang) {
      return { text: t('bot.templates.subscriptionReminder3dText', lang, { venueName: payload.venue_name, until: payload.until }) };
    },
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
    telegram(payload, lang) {
      return { text: t('bot.templates.subscriptionReminder1dText', lang, { venueName: payload.venue_name, until: payload.until }) };
    },
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
    telegram(payload, lang) {
      return { text: t('bot.templates.subscriptionExpiringTodayText', lang, { venueName: payload.venue_name }) };
    },
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
    telegram(payload, lang) {
      return { text: t('bot.templates.subscriptionGraceWarningText', lang, { venueName: payload.venue_name, days: payload.days }) };
    },
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
    telegram(payload, lang) {
      return { text: t('bot.templates.venueSuspendedText', lang, { venueName: payload.venue_name }) };
    },
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
    telegram(payload, lang) {
      return { text: t('bot.templates.subscriptionArchiveWarningText', lang, { venueName: payload.venue_name, days: payload.days }) };
    },
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

  // Промт 3.7. Уведомления по своему домену заведения. Все три идут владельцу ЗАВЕДЕНИЯ
  // (telegram, иначе email — правило одно, см. venueLifecycle.notifyVenue), потому что
  // действовать по ним должен он: поправить DNS, отключить ненужный домен, разослать новый
  // адрес гостям.
  domain_active: {
    telegram(payload, lang) {
      return { text: t('bot.templates.domainActiveText', lang, { venueName: payload.venue_name, domain: payload.domain }) };
    },
    email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const text = tt('bot.templates.domainActiveText', { venueName: payload.venue_name, domain: payload.domain });
      return {
        subject: tt('bot.templates.domainActiveSubject', { domain: payload.domain }),
        html: `<p>${escapeHtml(text)}</p>`,
        text,
      };
    },
  },

  domain_verification_failed: {
    telegram(payload, lang) {
      return { text: t('bot.templates.domainVerificationFailedText', lang, { venueName: payload.venue_name, domain: payload.domain }) };
    },
    email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const text = tt('bot.templates.domainVerificationFailedText', { venueName: payload.venue_name, domain: payload.domain });
      return {
        subject: tt('bot.templates.domainVerificationFailedSubject', { domain: payload.domain }),
        html: `<p>${escapeHtml(text)}</p>`,
        text,
      };
    },
  },

  domain_lost: {
    telegram(payload, lang) {
      return { text: t('bot.templates.domainLostText', lang, { venueName: payload.venue_name, domain: payload.domain }) };
    },
    email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const text = tt('bot.templates.domainLostText', { venueName: payload.venue_name, domain: payload.domain });
      return {
        subject: tt('bot.templates.domainLostSubject', { domain: payload.domain }),
        html: `<p>${escapeHtml(text)}</p>`,
        text,
      };
    },
  },

  // Промт 3.7: «Автопродление — стандартным таймером certbot, с алертом ВЛАДЕЛЬЦУ СЕРВИСА
  // при неудаче». Именно сервису, а не заведению: продление сертификата — наша работа,
  // и владелец кафе с ней ничего сделать не может.
  domain_cert_renew_failed: {
    telegram(payload, lang) {
      return { text: t('bot.templates.domainCertRenewFailedTelegram', lang, { domain: payload.domain, venueId: payload.venue_id, reason: payload.reason }) };
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

  // Промт 1.6 — подсказки застрявшим на онбординге, только Telegram (см. комментарий в
  // bot/worker/scheduler.js про то, почему здесь нет email-рендера в отличие от остальных
  // уведомлений о заведении в этом файле).
  // Промт 2.4 — владельцу, когда бот потерял доступ к группе заказов. Идёт через notifyVenue,
  // то есть при отсутствии Telegram уйдёт на email заведения, а если нет и его — владельцу
  // сервиса как manual_contact_needed.
  venue_group_unreachable: {
    telegram(payload, lang) {
      return { text: t('bot.templates.venueGroupUnreachableTelegram', lang, { venueName: payload.venue_name }) };
    },
  },

  // Промт 2.4 — заказ в группу заведения. Кнопки «Принят»/«Готово» обрабатывает сам процесс
  // бота (bot/handlers/orderActions.js) и редактирует ЭТО сообщение, поэтому воркер после
  // успешной отправки записывает message_id обратно в orders (см. worker/notifications.js).
  order_created: {
    telegram(payload, lang) {
      const lines = payload.lines.map((line) => {
        const options = line.options && line.options.length > 0 ? `\n   ${line.options.join(', ')}` : '';
        return `• ${line.qty} × ${line.name}${options}\n   ${Number(line.lineTotal).toLocaleString('ru-RU')} ${payload.currency}`;
      }).join('\n');

      const commentLine = payload.comment
        ? `\n\n${t('bot.orders.commentLine', lang, { comment: payload.comment })}`
        : '';

      const text = t('bot.orders.orderHeading', lang, { table: payload.table_number, orderId: payload.order_id })
        + `\n\n${lines}`
        + `\n\n${t('bot.orders.totalLine', lang, { total: Number(payload.total).toLocaleString('ru-RU'), currency: payload.currency })}`
        + commentLine;

      const buttons = [[
        Markup.button.callback(t('bot.orders.btnAccept', lang), `order:accept:${payload.order_id}`),
        Markup.button.callback(t('bot.orders.btnDone', lang), `order:done:${payload.order_id}`),
      ]];
      return { text, extra: Markup.inlineKeyboard(buttons) };
    },
  },

  waiter_call_created: {
    telegram(payload, lang) {
      const text = t('bot.orders.waiterHeading', lang, {
        table: payload.table_number,
        what: t(`bot.orders.callType_${payload.call_type}`, lang),
      });
      const buttons = [[Markup.button.callback(t('bot.orders.btnOnMyWay', lang), `waiter:ack:${payload.call_id}`)]];
      return { text, extra: Markup.inlineKeyboard(buttons) };
    },
  },

  // Промт 3.3 — низкая оценка владельцу немедленно. Идёт через notifyVenue (личный Telegram
  // владельца -> email заведения -> владелец сервиса), поэтому нужен и email-рендер: у части
  // заведений Telegram владельца не привязан, а именно это сообщение терять нельзя.
  review_low_rating: {
    telegram(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const parts = [tt('bot.reviews.lowHeading', { venueName: payload.venue_name, rating: payload.rating })];
      if (payload.table_number) parts.push(tt('bot.reviews.tableLine', { table: payload.table_number }));
      parts.push(payload.comment
        ? tt('bot.reviews.commentLine', { comment: payload.comment })
        : tt('bot.reviews.noComment'));
      if (payload.contact) parts.push(tt('bot.reviews.contactLine', { contact: payload.contact }));

      const button = Markup.button.url(tt('bot.reviews.openButton'), `${env.APP_BASE_URL}/admin/reviews`);
      return { text: parts.join('\n\n'), extra: Markup.inlineKeyboard([[button]]) };
    },
    async email(payload, lang) {
      const tt = (key, params) => t(key, lang, params);
      const siteSettings = await siteSettingsCache.get();
      const html = await ejs.renderFile(emailPath('review-low-rating'), {
        payload, t: tt, siteSettings, escapeHtml, appBaseUrl: env.APP_BASE_URL,
      });
      return {
        subject: tt('bot.reviews.lowSubject', { venueName: payload.venue_name, rating: payload.rating }),
        html,
        text: tt('bot.reviews.lowHeading', { venueName: payload.venue_name, rating: payload.rating })
          + '\n\n'
          + (payload.comment ? tt('bot.reviews.commentLine', { comment: payload.comment }) : tt('bot.reviews.noComment')),
      };
    },
  },

  // Промт 3.2, еженедельная сводка аналитики — bot/worker/scheduler.js, раз в понедельник.
  // Кнопка ведёт на саму страницу аналитики (обычная ссылка, не callback — открывается в
  // браузере, не в боте), тот же приём, что и receiptLine выше у payment_claim_created.
  weekly_analytics_summary: {
    telegram(payload, lang) {
      const dishesLine = payload.top_dishes.length > 0
        ? `\n${t('bot.templates.weeklySummaryTopDishes', lang, { dishes: payload.top_dishes.join(', ') })}`
        : '';
      const emptySearchLine = payload.top_empty_searches.length > 0
        ? `\n${t('bot.templates.weeklySummaryEmptySearches', lang, { queries: payload.top_empty_searches.join(', ') })}`
        : '';
      const trendText = payload.trend_percent === null
        ? ''
        : ` (${payload.trend_percent >= 0 ? '+' : ''}${payload.trend_percent}%)`;
      // Промт 3.3: высокие оценки владельца немедленно не дёргают — они приходят сюда, одной
      // строкой рядом с просмотрами. Строки нет вовсе, если за неделю не было ни одной оценки.
      const reviewsLine = payload.reviews_count > 0
        ? `\n${t('bot.templates.weeklySummaryReviews', lang, { count: payload.reviews_count, average: payload.reviews_average })}`
        : '';
      const text = t('bot.templates.weeklySummaryHeading', lang, { venueName: payload.venue_name })
        + `\n${t('bot.templates.weeklySummaryViews', lang, { count: payload.total_views })}${trendText}`
        + dishesLine + emptySearchLine + reviewsLine;
      const button = Markup.button.url(t('bot.templates.weeklySummaryButton', lang), `${env.APP_BASE_URL}/admin/analytics`);
      return { text, extra: Markup.inlineKeyboard([[button]]) };
    },
  },

  // Промт 4.2. Алерт владельцу сервиса о 500-й. Дедупликация живёт не здесь, а в
  // src/services/errorAlerts.js — шаблон только рисует то, что до него дошло.
  // В payload намеренно нет ни паролей, ни токенов, ни содержимого сессии: они срезаются
  // фильтром чувствительных ключей ещё до постановки в очередь.
  server_error: {
    telegram(payload, lang) {
      const parts = [t('bot.templates.serverErrorHeading', lang, { route: payload.route })];
      if (payload.venue_id) parts.push(t('bot.templates.serverErrorVenue', lang, { venueId: payload.venue_id }));
      if (payload.repeats > 0) parts.push(t('bot.templates.serverErrorRepeats', lang, { count: payload.repeats }));
      // Стек в моноширинном блоке: в Telegram он иначе сворачивается в кашу из-за переносов.
      // parse_mode Markdown, а не HTML: экранировать стек под HTML пришлось бы вручную,
      // а в моноширинном блоке Markdown спецсимволы значения не имеют.
      const fence = '```';
      parts.push(`${fence}\n${payload.stack}\n${fence}`);
      return { text: parts.join('\n\n'), extra: { parse_mode: 'Markdown' } };
    },
  },

  onboarding_stuck_no_items: {
    telegram(payload, lang) {
      return { text: t('bot.templates.onboardingStuckNoItemsTelegram', lang, { venueName: payload.venue_name }) };
    },
  },

  onboarding_stuck_draft: {
    telegram(payload, lang) {
      return { text: t('bot.templates.onboardingStuckDraftTelegram', lang, { venueName: payload.venue_name }) };
    },
  },

  onboarding_qr_reminder: {
    telegram(payload, lang) {
      return {
        text: t('bot.templates.onboardingQrReminderTelegram', lang, {
          venueName: payload.venue_name,
          url: `${env.APP_BASE_URL}/admin`,
        }),
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
