const express = require('express');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();
const { pool } = require('../config/db');
const env = require('../config/env');
const pgNotify = require('../services/pgNotify');
const logger = require('../services/logger');

// Промт 4.2, раздел 1. /health остаётся простым и быстрым (он в app.js) — его дёргает внешний
// монитор каждые пару минут. Здесь — подробный отчёт, который стоит дороже и наружу
// без пароля не отдаётся.

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');

// Пороги, при которых отчёт считается деградацией (ответ 503). Числа не из промта — он говорит
// «при деградации 503 с перечислением проблем», а что считать деградацией, решаем здесь.
const THRESHOLDS = {
  dbLatencyMs: 1000,
  diskFreeBytes: 1024 * 1024 * 1024, // 1 ГБ
  pendingNotifications: 500,
  heapUsedRatio: 0.92,
};

// Обход каталога uploads стоит дорого при тысячах файлов, а меняется его размер медленно.
// Кэшируем на минуту: /health/detailed могут дёрнуть подряд несколько раз, разбираясь
// с инцидентом, и каждый раз пересчитывать сотни мегабайт незачем.
const UPLOADS_CACHE_MS = 60 * 1000;
let uploadsCache = { at: 0, value: null };

// Токен сравнивается в постоянное время: обычное === утекает по времени сравнения, а токен
// здесь — единственное, что отделяет посторонних от сведений о диске, памяти и очередях.
function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isLocalRequest(req) {
  const ip = req.ip || '';
  // Express с trust proxy отдаёт в req.ip уже клиентский адрес из X-Forwarded-For, поэтому
  // «localhost» здесь — это именно запрос с самой машины, а не через прокси.
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function authorize(req) {
  if (isLocalRequest(req)) return true;
  const provided = req.get('x-health-token') || req.query.token;
  return tokenMatches(provided, env.HEALTH_TOKEN);
}

async function measureDb() {
  const startedAt = process.hrtime.bigint();
  await pool.query('SELECT 1');
  const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return {
    connected: true,
    latencyMs: Math.round(latencyMs * 100) / 100,
    // Счётчики самого пула pg: totalCount — созданные соединения, idleCount — свободные,
    // waitingCount — запросы, которые уже стоят в очереди за соединением. Последнее и есть
    // ранний признак того, что пул стал узким местом.
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
  };
}

async function measureDisk() {
  try {
    const stats = await fs.statfs(UPLOADS_ROOT).catch(() => fs.statfs(process.cwd()));
    const free = stats.bavail * stats.bsize;
    const total = stats.blocks * stats.bsize;
    return { freeBytes: free, totalBytes: total, freePercent: Math.round((free / total) * 100) };
  } catch (err) {
    // fs.statfs есть не везде (старые Node, экзотические ФС) — отсутствие данных о диске
    // не должно делать весь отчёт красным.
    return { error: err.message };
  }
}

async function measureUploads() {
  if (Date.now() - uploadsCache.at < UPLOADS_CACHE_MS && uploadsCache.value) {
    return { ...uploadsCache.value, cached: true };
  }

  let bytes = 0;
  let files = 0;
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(full);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const stat = await fs.stat(full).catch(() => null);
        if (stat) { bytes += stat.size; files += 1; }
      }
    }
  }
  await walk(UPLOADS_ROOT);

  const value = { bytes, files };
  uploadsCache = { at: Date.now(), value };
  return { ...value, cached: false };
}

async function lastMigration() {
  const result = await pool.query('SELECT name, run_on FROM pgmigrations ORDER BY id DESC LIMIT 1');
  const row = result.rows[0];
  return row ? { name: row.name, runOn: row.run_on } : null;
}

async function queueSizes() {
  const [notifications, claims] = await Promise.all([
    pool.query("SELECT count(*)::int AS count FROM notifications WHERE status = 'pending'"),
    pool.query("SELECT count(*)::int AS count FROM payment_claims WHERE status = 'pending'"),
  ]);
  return {
    pendingNotifications: notifications.rows[0].count,
    pendingPaymentClaims: claims.rows[0].count,
  };
}

// Промт 4.1 (бэкапы) ещё не сделан, механизма нет. Читаем необязательный файл состояния,
// который такой скрипт должен писать, и честно говорим «не настроено», если его нет.
// Рисовать зелёный статус для бэкапов, которых не существует, — худшее, что можно сделать
// в мониторинге.
async function lastBackup() {
  if (!env.BACKUP_STATE_FILE) return { configured: false };
  try {
    const raw = await fs.readFile(env.BACKUP_STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    return {
      configured: true,
      lastSuccessAt: state.lastSuccessAt || null,
      lastStatus: state.lastStatus || null,
      ageHours: state.lastSuccessAt
        ? Math.round((Date.now() - new Date(state.lastSuccessAt).getTime()) / 36e5)
        : null,
    };
  } catch (err) {
    return { configured: true, error: err.message };
  }
}

// Права на файлы: промт требует .env с 600 и uploads без исполнения. На Windows режимы POSIX
// не имеют смысла, поэтому там просто сообщаем, что проверка неприменима, — вместо того чтобы
// показывать бессмысленные цифры или, того хуже, «всё в порядке».
function filePermissions() {
  if (process.platform === 'win32') return { checked: false, reason: 'windows' };

  const result = { checked: true };
  const envPath = path.join(__dirname, '..', '..', '.env');
  try {
    const mode = fsSync.statSync(envPath).mode & 0o777;
    result.envMode = mode.toString(8).padStart(3, '0');
    // Группе и остальным не должно быть доступно ничего: 600 или строже.
    result.envOk = (mode & 0o077) === 0;
  } catch (err) {
    result.envMode = null;
    result.envOk = null;
  }
  try {
    const mode = fsSync.statSync(UPLOADS_ROOT).mode & 0o777;
    result.uploadsMode = mode.toString(8).padStart(3, '0');
    // Бит исполнения у КАТАЛОГА нужен для входа в него — проверяем не его, а отсутствие
    // права на запись для посторонних.
    result.uploadsOk = (mode & 0o022) === 0;
  } catch (err) {
    result.uploadsMode = null;
    result.uploadsOk = null;
  }
  return result;
}

router.get('/detailed', async (req, res) => {
  if (!authorize(req)) {
    // 404, а не 403: наличие подробного health-check — это тоже сведения, и посторонним
    // знать о нём незачем.
    return res.status(404).json({ error: 'not_found' });
  }

  const problems = [];
  const report = {
    status: 'ok',
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    env: env.NODE_ENV,
  };

  try {
    report.db = await measureDb();
    if (report.db.latencyMs > THRESHOLDS.dbLatencyMs) {
      problems.push(`БД отвечает медленно: ${report.db.latencyMs} мс`);
    }
  } catch (err) {
    report.db = { connected: false, error: err.message };
    problems.push(`Нет подключения к БД: ${err.message}`);
  }

  const memory = process.memoryUsage();
  report.memory = {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
  };
  if (memory.heapTotal > 0 && memory.heapUsed / memory.heapTotal > THRESHOLDS.heapUsedRatio) {
    problems.push(`Куча заполнена на ${Math.round((memory.heapUsed / memory.heapTotal) * 100)}%`);
  }

  report.disk = await measureDisk();
  if (typeof report.disk.freeBytes === 'number' && report.disk.freeBytes < THRESHOLDS.diskFreeBytes) {
    problems.push(`Мало места на диске: ${Math.round(report.disk.freeBytes / 1048576)} МБ`);
  }

  report.uploads = await measureUploads();
  report.listen = pgNotify.getStatus();
  if (!report.listen.listening && !report.listen.stopped) {
    problems.push('LISTEN-соединение с БД потеряно — кэш меню между процессами не синхронизируется');
  }

  try {
    report.migration = await lastMigration();
  } catch (err) {
    report.migration = { error: err.message };
  }

  try {
    const queues = await queueSizes();
    Object.assign(report, queues);
    if (queues.pendingNotifications > THRESHOLDS.pendingNotifications) {
      problems.push(`Очередь уведомлений выросла: ${queues.pendingNotifications} в ожидании`);
    }
  } catch (err) {
    report.queueError = err.message;
  }

  report.backup = await lastBackup();
  if (report.backup.configured === false) {
    problems.push('Бэкапы не настроены (BACKUP_STATE_FILE не задан)');
  } else if (report.backup.error) {
    problems.push(`Не удалось прочитать состояние бэкапов: ${report.backup.error}`);
  } else if (report.backup.ageHours !== null && report.backup.ageHours > 48) {
    problems.push(`Последний успешный бэкап был ${report.backup.ageHours} ч назад`);
  }

  report.permissions = filePermissions();
  if (report.permissions.checked && report.permissions.envOk === false) {
    problems.push(`.env доступен посторонним (режим ${report.permissions.envMode}, ожидается 600)`);
  }

  report.problems = problems;
  report.status = problems.length === 0 ? 'ok' : 'degraded';

  if (problems.length > 0) {
    logger.warn('health_degraded', { problems });
    return res.status(503).json(report);
  }
  return res.status(200).json(report);
});

module.exports = router;
