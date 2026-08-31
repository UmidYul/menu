const { Telegraf, Scenes, session } = require('telegraf');
const env = require('../src/config/env');
const logging = require('./middleware/logging');
const antiflood = require('./middleware/antiflood');
const { userLang } = require('./middleware/userLang');
const { scene: applyLeadScene } = require('./scenes/applyLead');
const startHandler = require('./handlers/start');
const helpHandler = require('./handlers/help');
const langHandler = require('./handlers/lang');
const ownerHandler = require('./handlers/owner');
const leadActionsHandler = require('./handlers/leadActions');
const paymentClaimActionsHandler = require('./handlers/paymentClaimActions');
const fallbackHandler = require('./handlers/fallback');

// TTL сессии — 30 минут: "незавершённые сцены очищаются через 30 минут неактивности" из
// промта 1.2 получаем от самого telegraf, без своей уборки — состояние визарда живёт в сессии,
// протухшая сессия = забытый сценарий.
const SESSION_TTL_SECONDS = 30 * 60;

function createBot() {
  const bot = new Telegraf(env.BOT_TOKEN);
  const stage = new Scenes.Stage([applyLeadScene]);

  bot.use(logging);
  bot.use(session({ ttl: SESSION_TTL_SECONDS }));
  bot.use(stage.middleware());
  bot.use(antiflood);
  bot.use(userLang);

  startHandler.register(bot);
  helpHandler.register(bot);
  langHandler.register(bot);
  ownerHandler.register(bot);
  leadActionsHandler.register(bot);
  paymentClaimActionsHandler.register(bot);
  // fallback — последним: ловит всё, что не забрали команды/колбэки выше.
  fallbackHandler.register(bot);

  // Ошибка в одном обработчике не должна ронять процесс — telegraf сам не гарантирует это без
  // bot.catch, дефолт — необработанное исключение уходит в общий error-обработчик самого telegraf,
  // который в некоторых версиях просто логирует, но полагаться на дефолт не будем.
  bot.catch((err, ctx) => {
    console.error(`bot: необработанная ошибка в обработчике (${ctx.updateType})`, err);
  });

  return bot;
}

module.exports = { createBot };
