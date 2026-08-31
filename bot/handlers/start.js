const { Markup } = require('telegraf');
const { t, SUPPORTED_LANGS } = require('../../src/i18n');
const telegramUserModel = require('../../src/models/telegramUserModel');

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

  bot.action('start:account', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(t('bot.start.accountComingSoon', ctx.state.lang));
  });

  bot.action('start:question', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(t('bot.start.askQuestionPrompt', ctx.state.lang));
  });
}

module.exports = { register, langKeyboard, mainMenuKeyboard, sendMainMenu };
