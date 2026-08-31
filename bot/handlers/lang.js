const { t, SUPPORTED_LANGS } = require('../../src/i18n');
const telegramUserModel = require('../../src/models/telegramUserModel');
const { langKeyboard, sendMainMenu } = require('./start');

function register(bot) {
  bot.command('lang', async (ctx) => {
    await ctx.reply(t('bot.start.chooseLangPrompt', ctx.state.lang), langKeyboard());
  });

  // 'lang:menu' — кнопка "🌐 Язык" в главном меню, ведёт сюда же.
  bot.action('lang:menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(t('bot.start.chooseLangPrompt', ctx.state.lang), langKeyboard());
  });

  SUPPORTED_LANGS.forEach((lang) => {
    bot.action(`lang:${lang}`, async (ctx) => {
      await ctx.answerCbQuery();
      await telegramUserModel.setLang(ctx.from.id, lang);
      ctx.state.lang = lang;
      await ctx.reply(t('bot.lang.saved', lang));
      // Первое подтверждение языка сразу переходит в главное меню — без этого новый
      // пользователь после выбора языка оставался бы без единой кнопки дальше.
      await sendMainMenu(ctx, lang);
    });
  });
}

module.exports = { register };
