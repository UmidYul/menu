const { t } = require('../../src/i18n');

function register(bot) {
  bot.command('help', async (ctx) => {
    await ctx.reply(t('bot.help.text', ctx.state.lang));
  });
}

module.exports = { register };
