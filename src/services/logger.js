const fs = require('fs');
const path = require('path');
const env = require('../config/env');

// Промт 4.2: «Логи писать структурированно в файл с ротацией, а не только в stdout».
//
// Без внешних зависимостей: winston/pino сюда тянуть незачем — нужен один файл, одна строка
// JSON на запись и ротация по размеру. Синхронная запись выбрана осознанно: логов немного,
// а асинхронная очередь теряет последние строки ровно тогда, когда они нужнее всего — при
// падении процесса.
//
// stdout остаётся: в докере и под pm2 его читают штатными средствами, файл — для случая
// «зайти на сервер и посмотреть, что было ночью».

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

let stream = null;
let currentPath = null;
let writtenBytes = 0;
let disabled = false;

function logDir() {
  return env.LOG_DIR;
}

function logPath() {
  return path.join(logDir(), 'app.log');
}

// Ротация по размеру: app.log -> app.log.1 -> ... -> app.log.5, самый старый удаляется.
// Не по дате: интерес представляет «последние N мегабайт», а не «что было 3 марта», и при
// тихом сервисе датированные файлы плодили бы пустышки.
function rotate() {
  try {
    const base = logPath();
    const oldest = `${base}.${MAX_FILES}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
      const from = `${base}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${base}.${i + 1}`);
    }
    if (fs.existsSync(base)) fs.renameSync(base, `${base}.1`);
  } catch (err) {
    // Ротация не удалась — продолжаем писать в текущий файл. Потерять логи хуже, чем
    // превысить лимит размера.
    process.stderr.write(`logger: не удалось повернуть файл логов: ${err.message}\n`);
  }
}

function ensureStream() {
  if (disabled) return null;
  if (stream && currentPath === logPath()) return stream;

  try {
    fs.mkdirSync(logDir(), { recursive: true });
    currentPath = logPath();
    writtenBytes = fs.existsSync(currentPath) ? fs.statSync(currentPath).size : 0;
    stream = fs.createWriteStream(currentPath, { flags: 'a' });
    stream.on('error', (err) => {
      process.stderr.write(`logger: ошибка записи в файл логов: ${err.message}\n`);
      disabled = true;
      stream = null;
    });
    return stream;
  } catch (err) {
    // Каталог недоступен (права, read-only ФС) — молча уходим в режим «только stdout».
    // Приложение не должно падать из-за того, что некуда писать лог.
    process.stderr.write(`logger: файл логов недоступен, пишу только в stdout: ${err.message}\n`);
    disabled = true;
    return null;
  }
}

function writeLine(line) {
  const target = ensureStream();
  if (!target) return;

  if (writtenBytes + line.length > MAX_FILE_BYTES) {
    target.end();
    stream = null;
    rotate();
    const next = ensureStream();
    if (!next) return;
    next.write(line);
    writtenBytes = line.length;
    return;
  }

  target.write(line);
  writtenBytes += line.length;
}

// Одна строка — один JSON-объект: так лог читается и глазами (`tail -f`), и grep'ом, и любым
// сборщиком логов, если он однажды появится.
function log(level, message, context) {
  const record = Object.assign({
    ts: new Date().toISOString(),
    level,
    msg: message,
  }, context || {});

  let line;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (err) {
    // Циклическая ссылка в контексте не должна ронять логирование.
    line = `${JSON.stringify({ ts: record.ts, level, msg: message, contextError: 'not serializable' })}\n`;
  }

  writeLine(line);

  // В stdout — то же самое, но человекочитаемо: смотреть JSON в консоли разработки неудобно.
  const consoleMethod = level === 'error' ? console.error : console.log;
  const extras = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  consoleMethod(`[${level}] ${message}${extras}`);
}

module.exports = {
  info: (message, context) => log('info', message, context),
  warn: (message, context) => log('warn', message, context),
  error: (message, context) => log('error', message, context),
  MAX_FILE_BYTES,
  MAX_FILES,
  logPath,
};
