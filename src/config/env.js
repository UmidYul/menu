const path = require('path');
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

// Username бота (без @) — нужен веб-процессу отдельно от BOT_TOKEN, чтобы собрать
// deep-link t.me/<username>?start=... (привязка Telegram, промт 1.5). Веб-процесс не
// держит соединения с Bot API и не может узнать username сам через getMe().
const botUsername = process.env.BOT_USERNAME || null;
if (botConfigured && !botUsername) {
  console.warn('env: BOT_USERNAME не задан — кнопка "Привязать Telegram" не сможет собрать ссылку на бота.');
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

// Промт 4.2. Каталог структурированных логов и токен подробного health-check.
// LOG_DIR по умолчанию — ./logs рядом с проектом: работает и в разработке, и под pm2.
// HEALTH_TOKEN не задан — /health/detailed доступен ТОЛЬКО с localhost (см. routes/health.js):
// открывать наружу сведения о диске, памяти и очередях без пароля нельзя.
const logDir = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const healthToken = process.env.HEALTH_TOKEN || null;
// Путь к файлу состояния бэкапов — его пишет скрипт бэкапа (промт 4.1, ещё не сделан).
// Не задан — health-check честно сообщает «бэкапы не настроены», а не рисует зелёный статус.
const backupStateFile = process.env.BACKUP_STATE_FILE || null;

// Промт 3.7. Свой домен заведения.
//
// SERVICE_HOST — собственный хост сервиса. Это ОПОРНАЯ точка всей маршрутизации по хосту:
// «Host не совпал с ним» и означает «это кастомный домен». Выводится из APP_BASE_URL, чтобы
// не заводить вторую правду о том, где живёт сервис, но переопределяется явно — в проде
// APP_BASE_URL может указывать на www, а служебным считается голый домен.
//
// Пустое значение (APP_BASE_URL не задан и SERVICE_HOST не задан) выключает маршрутизацию
// по хосту целиком: без знания собственного адреса отличить свой хост от чужого нельзя,
// и безопаснее не пытаться, чем угадывать.
function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
const serviceHost = (process.env.SERVICE_HOST || '').trim().toLowerCase() || hostOf(appBaseUrl);
if (isProduction && !serviceHost) {
  console.warn('env: SERVICE_HOST и APP_BASE_URL не заданы — свои домены заведений работать не будут.');
}

// Что владелец должен прописать у регистратора. CNAME предпочтительнее (переезд сервера
// не потребует от заведений менять DNS), A-запись — запасной путь для зон, где CNAME на корне
// не поддерживается. Инструкция в админке показывает оба, поэтому обе переменные опциональны
// по отдельности, но без хотя бы одной инструкция получится пустой.
const customDomainCnameTarget = (process.env.CUSTOM_DOMAIN_CNAME_TARGET || '').trim().toLowerCase() || serviceHost;
const serverIpv4 = (process.env.SERVER_IPV4 || '').trim() || null;

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL,
  LOG_DIR: logDir,
  HEALTH_TOKEN: healthToken,
  BACKUP_STATE_FILE: backupStateFile,
  SESSION_SECRET: process.env.SESSION_SECRET,
  PORT: port,
  NODE_ENV: nodeEnv,
  isProduction,
  APP_BASE_URL: appBaseUrl,

  // Промт 3.7
  SERVICE_HOST: serviceHost,
  CUSTOM_DOMAIN_CNAME_TARGET: customDomainCnameTarget,
  SERVER_IPV4: serverIpv4,
  customDomainsConfigured: Boolean(serviceHost),

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
  BOT_USERNAME: botUsername,
  BOT_MODE: botMode,
  BOT_PORT: Number(process.env.BOT_PORT) || 3001,
  BOT_WEBHOOK_URL: process.env.BOT_WEBHOOK_URL || null,
  BOT_WEBHOOK_SECRET: process.env.BOT_WEBHOOK_SECRET || null,
  OWNER_TELEGRAM_IDS: ownerTelegramIds,
};
