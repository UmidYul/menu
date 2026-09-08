const { Client } = require('pg');
const env = require('../config/env');
const { pool } = require('../config/db');
const menuCache = require('./menuCache');
const domainCache = require('./domainCache');
const menuVersionModel = require('../models/menuVersionModel');

const CHANNEL = 'menu_changed';
// Промт 3.7: «Результат поиска кэшировать в памяти с инвалидацией через тот же NOTIFY».
// Отдельный канал, а не общий с menu_changed: события совершенно разной частоты (меню меняется
// десятки раз в день, домен — раз в жизни), и подмешивать перезагрузку таблицы доменов к
// каждому сохранению позиции значило бы делать её впустую тысячи раз.
const DOMAIN_CHANNEL = 'domain_changed';
const MIN_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

let client = null;
let reconnectDelay = MIN_RECONNECT_DELAY_MS;
let reconnectTimer = null;
let stopped = true;
// Промт 4.2: статус LISTEN попадает в /health/detailed. Обрыв этого соединения не роняет
// приложение, но означает, что кэш меню между процессами больше не синхронизируется —
// снаружи это никак не видно, поэтому и нужен отдельный признак.
let listening = false;
let lastConnectedAt = null;
let lastErrorMessage = null;

function handleNotification(msg) {
  if (msg.channel === DOMAIN_CHANNEL) {
    // payload здесь не нужен: кэш доменов перечитывается целиком (см. domainCache.js).
    domainCache.invalidate();
    console.log('pgNotify: получено уведомление', DOMAIN_CHANNEL, '— список доменов перечитывается');
    return;
  }

  const venueId = Number(msg.payload);
  if (!Number.isInteger(venueId) || venueId <= 0) {
    console.warn('pgNotify: получен некорректный payload в', CHANNEL, msg.payload);
    return;
  }
  menuCache.invalidate(venueId);
  console.log('pgNotify: получено уведомление', CHANNEL, '— кэш заведения', venueId, 'сброшен');
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
}

// Реагирует и на 'error', и на 'end' одного и того же клиента — сравнение c === client
// отсекает событие от уже заменённого (предыдущего) соединения, чтобы не запланировать
// реконнект дважды на одну и ту же поломку.
function teardown(c) {
  if (c !== client) return;
  listening = false;
  client = null;
  c.removeAllListeners();
  c.end().catch(() => {});
  scheduleReconnect();
}

async function connect() {
  if (stopped) return;

  const c = new Client({ connectionString: env.DATABASE_URL });
  client = c;

  c.on('notification', handleNotification);
  c.on('error', (err) => {
    lastErrorMessage = err.message;
    console.error('pgNotify: ошибка LISTEN-соединения', err.message);
    teardown(c);
  });
  c.on('end', () => teardown(c));

  try {
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    await c.query(`LISTEN ${DOMAIN_CHANNEL}`);
    reconnectDelay = MIN_RECONNECT_DELAY_MS;
    // На случай, если это реконнект после обрыва — события menu_changed за это время могли
    // потеряться, так что нельзя доверять уже закэшированному HTML. На первом старте процесса
    // кэш и так пуст, так что вызов безвреден.
    menuCache.clear();
    // По той же причине перечитывается список доменов: за время обрыва домен мог стать
    // активным или быть отключён, а его события так же потерялись. Здесь это ещё и первичный
    // прогрев кэша на старте процесса.
    domainCache.reload();
    listening = true;
    lastConnectedAt = new Date();
    lastErrorMessage = null;
    console.log('pgNotify: подписка на', CHANNEL, 'установлена');
  } catch (err) {
    listening = false;
    lastErrorMessage = err.message;
    console.error('pgNotify: не удалось подключиться/подписаться, повтор через', reconnectDelay, 'мс —', err.message);
    teardown(c);
  }
}

// Вызывается один раз при старте приложения. Не бросает и не роняет процесс, даже если БД
// в этот момент недоступна, — просто уходит в цикл переподключений.
function start() {
  stopped = false;
  connect();
}

async function notifyMenuChanged(venueId) {
  await pool.query('SELECT pg_notify($1, $2)', [CHANNEL, String(venueId)]);
}

// Промт 3.7. Вызывается при любом изменении, влияющем на маршрутизацию по хосту: домен
// добавлен, активирован, отключён, удалён. Сбрасывает кэш в этом же процессе сразу, не дожидаясь
// эха собственного NOTIFY, — иначе следующий же запрос в этом процессе ушёл бы по старому списку.
async function publishDomainChange() {
  await domainCache.invalidate();
  await pool.query('SELECT pg_notify($1, $2)', [DOMAIN_CHANNEL, '']);
}

// Единая точка входа для "меню заведения изменилось": поднимает menu_version, сбрасывает кэш
// в этом же процессе сразу (не дожидаясь эха собственного NOTIFY) и уведомляет остальные процессы.
async function publishMenuChange(venueId) {
  await menuVersionModel.bump(venueId);
  menuCache.invalidate(venueId);
  await notifyMenuChanged(venueId);
}

// Для /health/detailed: «слушаем ли мы сейчас menu_changed» и когда подписка была установлена.
function getStatus() {
  return {
    listening,
    lastConnectedAt: lastConnectedAt ? lastConnectedAt.toISOString() : null,
    lastError: lastErrorMessage,
    stopped,
  };
}

module.exports = { start, notifyMenuChanged, publishMenuChange, publishDomainChange, getStatus };
