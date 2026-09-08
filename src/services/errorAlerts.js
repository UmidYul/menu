const crypto = require('crypto');
const env = require('../config/env');
const notificationModel = require('../models/notificationModel');
const logger = require('./logger');

// Промт 4.2, раздел 3: алерт владельцу сервиса при 500-х — С ОБЯЗАТЕЛЬНОЙ дедупликацией.
// «Иначе при массовой ошибке владелец получит тысячу сообщений и заблокирует бота» —
// это не гипотеза, а самый вероятный сценарий: 500-е обычно приходят пачками от одной причины.

// Одна и та же ошибка — не чаще раза в 15 минут. В следующем алерте указывается, сколько раз
// она повторилась за окно молчания: «×137» говорит о проблеме больше, чем 137 одинаковых
// сообщений подряд.
const DEDUP_WINDOW_MS = 15 * 60 * 1000;
// Потолок на размер памяти дедупликатора: разных стеков за 15 минут столько не бывает, а если
// вдруг бывает — значит, всё настолько плохо, что счётчики уже не главная забота.
const MAX_TRACKED = 200;

// Ключи, значения которых не должны попасть в Telegram ни при каких обстоятельствах.
// Сравнение по подстроке в нижнем регистре: _csrf, csrfToken, X-CSRF-Token — одно и то же.
const SENSITIVE_KEY_PARTS = [
  'password', 'passwd', 'secret', 'token', 'csrf', 'cookie', 'authorization',
  'auth', 'session', 'apikey', 'api_key', 'hash', 'card', 'cvv', 'pin',
];

const REDACTED = '[скрыто]';
const MAX_STACK_LINES = 6;
const MAX_VALUE_LENGTH = 200;

function isSensitiveKey(key) {
  const lower = String(key).toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

// Рекурсивная чистка: в алерт попадают только безопасные значения. Глубина ограничена —
// в req.body бывают вложенные объекты, но не бесконечные, а защита от циклов нужна всегда.
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 3) return '[…]';

  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitize(item, depth + 1));

  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).slice(0, 25).forEach((key) => {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitize(value[key], depth + 1);
    });
    return out;
  }

  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
  }
  return value;
}

// Ключ дедупликации — по стеку, а не по сообщению: одна и та же строка «Cannot read properties
// of undefined» из разных мест кода это разные проблемы, и склеивать их нельзя.
function fingerprint(err, req) {
  const stack = (err && err.stack) || String(err);
  const head = stack.split('\n').slice(0, 3).join('\n');
  const route = req ? `${req.method} ${req.route ? req.route.path : req.path}` : '';
  return crypto.createHash('sha256').update(`${route}\n${head}`).digest('hex').slice(0, 16);
}

const seen = new Map();

function shouldSend(key) {
  const now = Date.now();
  const entry = seen.get(key);

  if (!entry || now - entry.lastSentAt > DEDUP_WINDOW_MS) {
    const suppressed = entry ? entry.suppressed : 0;
    seen.set(key, { lastSentAt: now, suppressed: 0 });

    // Подчистка старых записей делается здесь, а не по таймеру: таймер держал бы процесс
    // и требовал бы отдельной остановки в тестах.
    if (seen.size > MAX_TRACKED) {
      const cutoff = now - DEDUP_WINDOW_MS;
      for (const [existingKey, existingEntry] of seen) {
        if (existingEntry.lastSentAt < cutoff) seen.delete(existingKey);
      }
    }
    return { send: true, suppressed };
  }

  entry.suppressed += 1;
  return { send: false, suppressed: entry.suppressed };
}

function buildPayload(err, req, suppressed) {
  const stackLines = ((err && err.stack) || String(err)).split('\n').slice(0, MAX_STACK_LINES);

  // ТОЛЬКО путь, без query-строки. req.originalUrl несёт её целиком, и секрет, переданный
  // параметром (?token=..., ?password=...), утёк бы в алерт мимо фильтра — тот чистит разобранный
  // req.query, а не сырую строку. Поймано сквозной проверкой на настоящей 500-ке.
  // Сами параметры ниже, в поле query, уже очищенные.
  const path = req ? String(req.originalUrl || req.url || '').split('?')[0] : '';

  return {
    route: req ? `${req.method} ${path}` : 'unknown',
    // id заведения, если запрос был из кабинета: без него в алерте невозможно понять,
    // у кого именно сломалось.
    venue_id: (req && req.session && req.session.admin && req.session.admin.venueId) || null,
    role: (req && req.session && req.session.admin && req.session.admin.role) || null,
    message: (err && err.message) || String(err),
    stack: stackLines.join('\n'),
    // Тело запроса — уже очищенное. Именно оно чаще всего объясняет, ЧТО сломало обработчик.
    body: req ? sanitize(req.body) : null,
    query: req ? sanitize(req.query) : null,
    repeats: suppressed,
  };
}

// Алерт уходит через ту же очередь notifications, что и все остальные сообщения бота: веб-процесс
// не держит соединения с Bot API, а очередь переживает перезапуск воркера.
async function reportServerError(err, req) {
  const key = fingerprint(err, req);
  const decision = shouldSend(key);

  const payload = buildPayload(err, req, decision.suppressed);
  logger.error('server_error', { fingerprint: key, ...payload, alerted: decision.send });

  if (!decision.send) return;
  if (env.OWNER_TELEGRAM_IDS.length === 0) return;

  for (const ownerId of env.OWNER_TELEGRAM_IDS) {
    try {
      // dedupKey с окном времени: если два процесса поймают одну и ту же ошибку одновременно,
      // владелец всё равно получит одно сообщение.
      const window = Math.floor(Date.now() / DEDUP_WINDOW_MS);
      // eslint-disable-next-line no-await-in-loop
      await notificationModel.enqueue(null, {
        channel: 'telegram',
        recipient: String(ownerId),
        template: 'server_error',
        payload,
        lang: 'ru',
        dedupKey: `server_error:${key}:${window}:${ownerId}`,
      });
    } catch (enqueueErr) {
      // Не смогли поставить алерт в очередь — это не повод уронить обработчик ошибок.
      logger.error('error_alert_enqueue_failed', { message: enqueueErr.message });
    }
  }
}

module.exports = {
  reportServerError,
  sanitize,
  fingerprint,
  DEDUP_WINDOW_MS,
  // Экспортируется для проверок: скрипт должен уметь обнулить состояние между сценариями.
  _resetForTests: () => seen.clear(),
};
