const { z } = require('zod');
const { SERVICE_NAME } = require('./constants');

// Без этих двух приложение не может работать вообще — падаем сразу с понятным сообщением,
// а не где-то на первом запросе к БД или к сессии.
const requiredSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL не задан'),
  SESSION_SECRET: z.string().min(1, 'SESSION_SECRET не задан'),
});

const parsed = requiredSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Некорректная конфигурация окружения:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const port = Number(process.env.PORT) || 3000;

// SMTP/BOT_TOKEN/APP_BASE_URL опциональны — их отсутствие не мешает стартовать, только
// отключает зависящие от них функции (почта, бот, корректные ссылки в письмах).
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
if (!smtpConfigured) {
  console.warn(
    'env: SMTP не сконфигурирован (нужны SMTP_HOST и MAIL_FROM) — письма не будут отправляться, ' +
      'mailer.send() будет молча пропускать отправку.'
  );
}

const botConfigured = Boolean(process.env.BOT_TOKEN);
if (!botConfigured) {
  console.warn('env: BOT_TOKEN не задан — функции, связанные с Telegram-ботом, отключены.');
}

const botMode = process.env.BOT_MODE === 'webhook' ? 'webhook' : 'polling';
const ownerTelegramIds = (process.env.OWNER_TELEGRAM_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
  .map(Number)
  .filter((id) => Number.isInteger(id) && id > 0);

const appBaseUrl = process.env.APP_BASE_URL || (isProduction ? '' : `http://localhost:${port}`);
if (!appBaseUrl) {
  console.warn('env: APP_BASE_URL не задан — ссылки в письмах и в боте будут некорректны.');
}

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL,
  SESSION_SECRET: process.env.SESSION_SECRET,
  PORT: port,
  NODE_ENV: nodeEnv,
  isProduction,
  APP_BASE_URL: appBaseUrl,

  SMTP_HOST: process.env.SMTP_HOST || null,
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER || null,
  SMTP_PASS: process.env.SMTP_PASS || null,
  MAIL_FROM: process.env.MAIL_FROM || null,
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || SERVICE_NAME,
  smtpConfigured,

  BOT_TOKEN: process.env.BOT_TOKEN || null,
  botConfigured,
  BOT_MODE: botMode,
  BOT_PORT: Number(process.env.BOT_PORT) || 3001,
  BOT_WEBHOOK_URL: process.env.BOT_WEBHOOK_URL || null,
  BOT_WEBHOOK_SECRET: process.env.BOT_WEBHOOK_SECRET || null,
  OWNER_TELEGRAM_IDS: ownerTelegramIds,
};
