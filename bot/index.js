require('dotenv').config();

const env = require('../src/config/env');
const { pool } = require('../src/config/db');
const { t } = require('../src/i18n');
const { createBot } = require('./bot');
const { startNotificationWorker } = require('./worker/notifications');
const { startLifecycleScheduler } = require('./worker/scheduler');
const { startDomainScheduler } = require('./worker/domainScheduler');

if (!env.botConfigured) {
  console.error('bot: BOT_TOKEN не задан — процесс бота не может стартовать. Веб-приложение при этом продолжает работать, уведомления будут копиться в очереди со статусом pending.');
  process.exit(1);
}

const ALERT_DEDUP_MS = 15 * 60_000;
const lastAlertAt = new Map(); // fingerprint (первые 200 символов сообщения) -> timestamp

async function alertOwners(bot, message) {
  const fingerprint = message.slice(0, 200);
  const last = lastAlertAt.get(fingerprint);
  if (last && Date.now() - last < ALERT_DEDUP_MS) return;
  lastAlertAt.set(fingerprint, Date.now());

  for (const ownerId of env.OWNER_TELEGRAM_IDS) {
    try {
      await bot.telegram.sendMessage(ownerId, t('bot.alert.unhandledError', 'ru', { message: message.slice(0, 500) }));
    } catch (err) {
      console.error('bot: не удалось отправить алерт владельцу', ownerId, err.message);
    }
  }
}

async function launch(bot) {
  if (env.BOT_MODE === 'webhook') {
    if (!env.BOT_WEBHOOK_URL || !env.BOT_WEBHOOK_SECRET) {
      console.error('bot: BOT_MODE=webhook требует BOT_WEBHOOK_URL и BOT_WEBHOOK_SECRET в .env');
      process.exit(1);
    }
    const express = require('express');
    const app = express();
    const webhookPath = `/webhook/${env.BOT_WEBHOOK_SECRET}`;

    // webhookCallback сам сверяет заголовок X-Telegram-Bot-Api-Secret-Token (константным
    // сравнением) и отбрасывает запрос без него/с неверным значением — до express.json() не
    // доходит и не нужен, тело читает сам telegraf.
    app.use(webhookPath, bot.webhookCallback(webhookPath, { secretToken: env.BOT_WEBHOOK_SECRET }));
    app.listen(env.BOT_PORT, () => {
      console.log(`bot: webhook-сервер слушает порт ${env.BOT_PORT}`);
    });

    await bot.telegram.setWebhook(`${env.BOT_WEBHOOK_URL}${webhookPath}`, {
      secret_token: env.BOT_WEBHOOK_SECRET,
    });
    console.log('bot: вебхук зарегистрирован —', env.BOT_WEBHOOK_URL + webhookPath);
    return;
  }

  // polling: если бот уже запущен где-то ещё под этим же токеном, Telegram отвечает 409 —
  // не крутимся в бесконечных ошибках, а завершаемся с понятным сообщением.
  bot.launch().catch((err) => {
    if (err && err.response && err.response.error_code === 409) {
      console.error('bot: конфликт polling (409) — похоже, бот уже запущен другим процессом под этим токеном. Завершаюсь.');
      process.exit(1);
    }
    console.error('bot: не удалось запустить polling', err);
    process.exit(1);
  });
  console.log('bot: запущен в режиме polling');
}

async function main() {
  const bot = createBot();
  await launch(bot);

  const worker = startNotificationWorker(bot);
  const scheduler = startLifecycleScheduler();
  // Промт 3.7: свой такт (минута против часа у планировщика подписок) — см. domainScheduler.js.
  const domainScheduler = startDomainScheduler();

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    console.error('bot: необработанный reject промиса', message);
    alertOwners(bot, message).catch(() => {});
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`bot: получен ${signal}, завершаюсь — новые задачи не забираем, ждём текущие`);
    try {
      await worker.stop();
      await scheduler.stop();
      await domainScheduler.stop();
      if (env.BOT_MODE !== 'webhook') bot.stop(signal);
      await pool.end();
    } catch (err) {
      console.error('bot: ошибка при завершении', err);
    } finally {
      process.exit(0);
    }
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('bot: фатальная ошибка при старте', err);
  process.exit(1);
});
