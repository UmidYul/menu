const { Client } = require('pg');
const env = require('../config/env');
const { pool } = require('../config/db');
const menuCache = require('./menuCache');
const menuVersionModel = require('../models/menuVersionModel');

const CHANNEL = 'menu_changed';
const MIN_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

let client = null;
let reconnectDelay = MIN_RECONNECT_DELAY_MS;
let reconnectTimer = null;
let stopped = true;

function handleNotification(msg) {
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
    console.error('pgNotify: ошибка LISTEN-соединения', err.message);
    teardown(c);
  });
  c.on('end', () => teardown(c));

  try {
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    reconnectDelay = MIN_RECONNECT_DELAY_MS;
    // На случай, если это реконнект после обрыва — события menu_changed за это время могли
    // потеряться, так что нельзя доверять уже закэшированному HTML. На первом старте процесса
    // кэш и так пуст, так что вызов безвреден.
    menuCache.clear();
    console.log('pgNotify: подписка на', CHANNEL, 'установлена');
  } catch (err) {
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

// Единая точка входа для "меню заведения изменилось": поднимает menu_version, сбрасывает кэш
// в этом же процессе сразу (не дожидаясь эха собственного NOTIFY) и уведомляет остальные процессы.
async function publishMenuChange(venueId) {
  await menuVersionModel.bump(venueId);
  menuCache.invalidate(venueId);
  await notifyMenuChanged(venueId);
}

module.exports = { start, notifyMenuChanged, publishMenuChange };
