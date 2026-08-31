const { message } = require('telegraf/filters');
const { Markup } = require('telegraf');
const { t, DEFAULT_LANG } = require('../../src/i18n');
const env = require('../../src/config/env');
const telegramUserModel = require('../../src/models/telegramUserModel');
const { isOwner } = require('../lib/owner');
const supportBridge = require('../lib/supportBridge');
const { tryConsumeRejectReason } = require('./leadActions');

async function langOf(telegramId) {
  const user = await telegramUserModel.findById(telegramId);
  return (user && user.lang) || DEFAULT_LANG;
}

function displayName(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return from.username ? `${name} (@${from.username})` : name || String(from.id);
}

// Пересылает текст владельцам (их может быть несколько — OWNER_TELEGRAM_ID через запятую)
// и запоминает, какому пользователю отвечать, если владелец использует Reply на это сообщение.
async function forwardToOwners(ctx, text) {
  const name = displayName(ctx.from);
  for (const ownerId of env.OWNER_TELEGRAM_IDS) {
    try {
      const ownerLang = await langOf(ownerId);
      const sent = await ctx.telegram.sendMessage(
        ownerId,
        `${t('bot.owner.forwardHeader', ownerLang, { name, id: ctx.from.id })}\n\n${text}\n\n${t('bot.owner.replyHint', ownerLang)}`,
        Markup.inlineKeyboard([[Markup.button.callback(t('bot.owner.replyButton', ownerLang), `reply_hint:${ctx.from.id}`)]])
      );
      supportBridge.remember(ownerId, sent.message_id, ctx.from.id, name);
    } catch (err) {
      console.error('bot: не удалось переслать сообщение владельцу', ownerId, err.message);
    }
  }
}

// Владелец ответил (Telegram Reply) на пересланное сообщение — уходит исходному пользователю
// от имени бота.
async function handleOwnerReply(ctx) {
  const repliedId = ctx.message.reply_to_message.message_id;
  const target = supportBridge.resolve(ctx.from.id, repliedId);
  if (!target) return false;

  const text = ctx.message.text;
  if (!text) return false;

  try {
    const targetLang = await langOf(target.telegramId);
    await ctx.telegram.sendMessage(target.telegramId, `${t('bot.owner.replyFromServicePrefix', targetLang)}\n${text}`);
    await ctx.reply(t('bot.owner.replySent', ctx.state.lang));
  } catch (err) {
    console.error('bot: не удалось отправить ответ пользователю', target.telegramId, err.message);
    await ctx.reply(t('bot.owner.replyFailed', ctx.state.lang));
  }
  return true;
}

function register(bot) {
  bot.action(/^reply_hint:/, async (ctx) => {
    await ctx.answerCbQuery(t('bot.owner.replyHint', ctx.state.lang), { show_alert: true });
  });

  // Регистрируется последним: команды и action-колбэки выше уже забрали то, что понимают,
  // сюда попадает всё остальное текстовое.
  bot.on(message('text'), async (ctx) => {
    if (await tryConsumeRejectReason(ctx)) return;

    if (isOwner(ctx.from.id) && ctx.message.reply_to_message) {
      const handled = await handleOwnerReply(ctx);
      if (handled) return;
    }

    const text = ctx.message.text;
    await ctx.reply(t('bot.fallback.reply', ctx.state.lang));

    if (supportBridge.looksMeaningful(text)) {
      await forwardToOwners(ctx, text);
      await ctx.reply(t('bot.fallback.forwarded', ctx.state.lang));
    }
  });
}

module.exports = { register };
