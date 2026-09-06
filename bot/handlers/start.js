const { Markup } = require('telegraf');
const { t, SUPPORTED_LANGS } = require('../../src/i18n');
const telegramUserModel = require('../../src/models/telegramUserModel');
const adminModel = require('../../src/models/adminModel');
const passwordResetTokenModel = require('../../src/models/passwordResetTokenModel');
const telegramLink = require('../../src/services/telegramLink');
const env = require('../../src/config/env');

const LINK_PAYLOAD_PREFIX = 'link_';

function langKeyboard() {
  return Markup.inlineKeyboard(
    SUPPORTED_LANGS.map((lang) => Markup.button.callback(t(`bot.lang.${lang}`, lang), `lang:${lang}`))
  );
}

function mainMenuKeyboard(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t('bot.start.btnConnect', lang), 'start:connect')],
    [Markup.button.callback(t('bot.start.btnHaveAccount', lang), 'start:account')],
    [Markup.button.callback(t('bot.start.btnAskQuestion', lang), 'start:question')],
    [Markup.button.callback(t('bot.start.btnChangeLang', lang), 'lang:menu')],
  ]);
}

async function sendMainMenu(ctx, lang) {
  await ctx.reply(t('bot.start.greeting', lang), mainMenuKeyboard(lang));
}

function register(bot) {
  // Новый пользователь сначала подтверждает язык (мы только угадали его по language_code) —
  // главное меню показываем уже после выбора, в handlers/lang.js. Вернувшийся пользователь
  // видит is_blocked=false (мог раньше заблокировать бота и написать заново) и сразу меню.
  bot.command('start', async (ctx) => {
    await telegramUserModel.setBlocked(ctx.from.id, false);
    const lang = ctx.state.lang;

    // Deep-link привязки Telegram (промт 1.5): t.me/<bot>?start=link_<code> — код с кнопки
    // "Привязать Telegram" в /admin/password. Приоритетнее выбора языка/приветствия — если
    // человек пришёл по этой ссылке, у него уже есть конкретная цель, а не знакомство с ботом.
    // ctx.payload, а не ctx.startPayload — последний Telegraf проставляет только через
    // отдельный метод bot.start(handler), а не при обычной bot.command('start', handler),
    // которую мы используем здесь (нужен полный контроль над веткой isNewUser выше по файлу).
    const payload = ctx.payload;
    if (payload && payload.startsWith(LINK_PAYLOAD_PREFIX)) {
      const code = payload.slice(LINK_PAYLOAD_PREFIX.length);
      const result = await telegramLink.consumeLinkCode(code, ctx.from.id);
      if (result.ok) {
        await ctx.reply(t('bot.account.linkSuccess', lang, { venueName: result.venueName }));
      } else {
        await ctx.reply(t('bot.account.linkInvalidCode', lang));
      }
      await sendMainMenu(ctx, lang);
      return;
    }

    if (ctx.state.isNewUser) {
      await ctx.reply(t('bot.start.chooseLangPrompt', lang), langKeyboard());
      return;
    }

    await sendMainMenu(ctx, lang);
  });

  bot.action('start:connect', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('apply-lead');
  });

  // "У меня уже есть аккаунт" — если этот Telegram уже привязан к admins (промт 1.5), предлагает
  // восстановление пароля; если нет, объясняет, что привязка делается из панели управления
  // (кнопка "Привязать Telegram" на /admin/password), а не отсюда — код всегда исходит от админки.
  bot.action('start:account', async (ctx) => {
    await ctx.answerCbQuery();
    const lang = ctx.state.lang;
    const admin = await adminModel.findByTelegramId(ctx.from.id);
    if (admin) {
      await ctx.reply(
        t('bot.account.linkedMenu', lang, { login: admin.login }),
        Markup.inlineKeyboard([[Markup.button.callback(t('bot.account.btnForgotPassword', lang), 'account:forgot')]])
      );
    } else {
      await ctx.reply(t('bot.account.notLinkedHint', lang));
    }
  });

  bot.action('account:forgot', async (ctx) => {
    await ctx.answerCbQuery();
    const lang = ctx.state.lang;
    const admin = await adminModel.findByTelegramId(ctx.from.id);
    if (!admin) {
      await ctx.reply(t('bot.account.notLinkedHint', lang));
      return;
    }
    const rawToken = await passwordResetTokenModel.create(admin.id, {});
    const resetUrl = `${env.APP_BASE_URL}/admin/reset?token=${rawToken}`;
    await ctx.reply(t('bot.account.forgotLinkSent', lang, { url: resetUrl }));
  });

  bot.action('start:question', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(t('bot.start.askQuestionPrompt', ctx.state.lang));
  });
}

module.exports = { register, langKeyboard, mainMenuKeyboard, sendMainMenu };
