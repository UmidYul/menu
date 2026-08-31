const { Markup } = require('telegraf');
const { t, DEFAULT_LANG } = require('../../src/i18n');
const env = require('../../src/config/env');
const telegramUserModel = require('../../src/models/telegramUserModel');
const supportBridge = require('./supportBridge');

async function langOf(telegramId) {
  const user = await telegramUserModel.findById(telegramId);
  return (user && user.lang) || DEFAULT_LANG;
}

function leadCardText(lead, lang) {
  return t('bot.lead.card', lang, {
    venueName: lead.venue_name,
    city: lead.city || t('bot.apply.summaryEmpty', lang),
    venueType: lead.venue_type ? t(`bot.apply.venueType.${lead.venue_type}`, lang) : t('bot.apply.summaryEmpty', lang),
    contactName: lead.contact_name,
    phone: lead.phone,
    comment: lead.comment || t('bot.apply.summaryEmpty', lang),
    source: t(`bot.lead.source.${lead.source}`, lang),
  });
}

// Текст + клавиатура карточки заявки — чистая функция, без похода в Telegram. Переиспользуется
// и прямой отправкой из сценария бота (notifyOwnersNewLead ниже), и шаблоном 'lead_created'
// в bot/templates/notifications.js (заявки с сайта идут через очередь — веб-процесс не имеет
// живого соединения с Bot API, см. промт 0.1 про outbox).
function buildLeadCardMessage(lead, lang) {
  const buttons = [
    [
      Markup.button.callback(t('bot.lead.btnApprove', lang), `lead:approve:${lead.id}`),
      Markup.button.callback(t('bot.lead.btnReject', lang), `lead:reject:${lead.id}`),
    ],
  ];
  if (lead.telegram_id) {
    buttons.push([Markup.button.callback(t('bot.lead.btnReplyHint', lang), `reply_hint:${lead.telegram_id}`)]);
  }

  return {
    text: `${t('bot.lead.newLeadHeader', lang)}\n\n${leadCardText(lead, lang)}`,
    extra: Markup.inlineKeyboard(buttons),
  };
}

// Прямая отправка из процесса бота (заявка создана прямо в сценарии — живой telegram-клиент
// уже под рукой). Дополнительно запоминает сообщение в supportBridge, чтобы Reply на карточку
// в Telegram ушёл заявителю — та же механика, что и для обычных сообщений в поддержку.
async function notifyOwnersNewLead(telegram, lead) {
  for (const ownerId of env.OWNER_TELEGRAM_IDS) {
    const lang = await langOf(ownerId);
    const { text, extra } = buildLeadCardMessage(lead, lang);
    try {
      const sent = await telegram.sendMessage(ownerId, text, extra);
      if (lead.telegram_id) {
        supportBridge.remember(ownerId, sent.message_id, lead.telegram_id, lead.contact_name);
      }
    } catch (err) {
      console.error('bot: не удалось отправить карточку заявки владельцу', ownerId, err.message);
    }
  }
}

module.exports = { notifyOwnersNewLead, buildLeadCardMessage, langOf };
