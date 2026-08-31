const notificationModel = require('../../src/models/notificationModel');
const telegramUserModel = require('../../src/models/telegramUserModel');
const mailer = require('../../src/services/mailer');
const { renderNotification } = require('../templates/notifications');

const POLL_INTERVAL_MS = 10_000;
const BATCH_SIZE = 20;

// "Максимум 5 попыток, задержки 1м/5м/15м/1ч/6ч" из промта 0.1: пять чисел на пять попыток дают
// только 4 промежутка между ними, поэтому 6ч в графике фактически не используется — после 5-й
// неудачной попытки записи сразу становится 'failed', без ожидания.
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function nextRetryAt(attempts) {
  if (attempts >= MAX_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return new Date(Date.now() + delay);
}

// Простой троттлер исходящих в Telegram: не больше ~25/с глобально и не чаще 1/с в один чат.
function createTelegramThrottle() {
  let lastGlobalSendAt = 0;
  const lastPerChatSendAt = new Map();
  const GLOBAL_MIN_GAP_MS = 1000 / 25;
  const PER_CHAT_MIN_GAP_MS = 1000;

  return async function throttle(chatId) {
    const wait = () => {
      const now = Date.now();
      const globalGap = now - lastGlobalSendAt;
      const chatGap = now - (lastPerChatSendAt.get(chatId) || 0);
      return Math.max(0, GLOBAL_MIN_GAP_MS - globalGap, PER_CHAT_MIN_GAP_MS - chatGap);
    };
    const delay = wait();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    lastGlobalSendAt = Date.now();
    lastPerChatSendAt.set(chatId, Date.now());
  };
}

async function processTelegramRow(telegram, throttle, row) {
  const content = await renderNotification('telegram', row.template, row.payload, row.lang);
  if (!content) {
    await notificationModel.markFailed(row.id, `Неизвестный шаблон для telegram: ${row.template}`, null);
    return;
  }

  await throttle(row.recipient);
  try {
    await telegram.sendMessage(row.recipient, content.text, content.extra);
    await notificationModel.markSent(row.id);
  } catch (err) {
    if (err.code === 403) {
      await telegramUserModel.setBlocked(row.recipient, true).catch(() => {});
      await notificationModel.markSkipped(row.id, 'Пользователь заблокировал бота (403)');
      return;
    }
    if (err.code === 429) {
      const retryAfterSec = (err.parameters && err.parameters.retry_after) || 30;
      await notificationModel.markFailed(row.id, `429 Too Many Requests, retry_after=${retryAfterSec}`, new Date(Date.now() + retryAfterSec * 1000));
      return;
    }
    await notificationModel.markFailed(row.id, String((err && err.message) || err), nextRetryAt(row.attempts));
  }
}

async function processEmailRow(row) {
  const content = await renderNotification('email', row.template, row.payload, row.lang);
  if (!content) {
    await notificationModel.markFailed(row.id, `Неизвестный шаблон для email: ${row.template}`, null);
    return;
  }

  try {
    const result = await mailer.send({ to: row.recipient, subject: content.subject, html: content.html, text: content.text });
    if (result.skipped) {
      // SMTP не настроен — не ошибка получателя, а временная (пока не настроят) конфигурация:
      // ретраим по тому же графику, а не тихо считаем отправленным.
      await notificationModel.markFailed(row.id, 'SMTP не настроен', nextRetryAt(row.attempts));
      return;
    }
    await notificationModel.markSent(row.id);
  } catch (err) {
    const isInvalidAddress = err.code === 'EENVELOPE' || err.responseCode === 550;
    if (isInvalidAddress) {
      await notificationModel.markFailed(row.id, String(err.message || err), null);
      return;
    }
    await notificationModel.markFailed(row.id, String((err && err.message) || err), nextRetryAt(row.attempts));
  }
}

// Раз в 10с забирает пачку из notifications (claimBatch — под FOR UPDATE SKIP LOCKED в модели)
// и отправляет по каналу. bot передаётся, чтобы переиспользовать один Telegraf-инстанс, а не
// открывать второе соединение к Bot API.
function startNotificationWorker(bot) {
  const throttle = createTelegramThrottle();
  let stopped = false;
  let timer = null;
  let inFlight = null;

  async function tick() {
    inFlight = (async () => {
      let batch;
      try {
        batch = await notificationModel.claimBatch(BATCH_SIZE);
      } catch (err) {
        console.error('worker: не удалось забрать пачку уведомлений', err);
        return;
      }

      for (const row of batch) {
        try {
          if (row.channel === 'telegram') {
            await processTelegramRow(bot.telegram, throttle, row);
          } else if (row.channel === 'email') {
            await processEmailRow(row);
          } else {
            await notificationModel.markFailed(row.id, `Неизвестный канал: ${row.channel}`, null);
          }
        } catch (err) {
          console.error('worker: ошибка обработки уведомления', row.id, err);
        }
      }
    })();

    await inFlight;
    inFlight = null;
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
  };
}

module.exports = { startNotificationWorker };
