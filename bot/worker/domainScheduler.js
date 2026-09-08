const { pool } = require('../../src/config/db');
const venueDomainModel = require('../../src/models/venueDomainModel');
const domainVerification = require('../../src/services/domainVerification');
const pgNotify = require('../../src/services/pgNotify');
const venueLifecycle = require('../../src/services/venueLifecycle');
const env = require('../../src/config/env');
const notificationModel = require('../../src/models/notificationModel');

// Промт 3.7, раздел 3: «Периодическая проверка DNS из планировщика (dns.promises.resolve),
// не чаще раза в 5 минут на домен, с экспоненциальным отступом при неудачах и остановкой
// через 48 часов с переводом в 'failed'».
//
// ОТДЕЛЬНЫЙ планировщик, а не ветка в worker/scheduler.js: тот тикает раз в час — правильный
// такт для подписок и напоминаний, но для «раза в 5 минут» он бесполезен. Здесь тик минутный,
// а сам интервал на домен держит next_check_at в БД: он переживает перезапуск процесса,
// в отличие от любого счётчика в памяти.
const TICK_INTERVAL_MS = 60 * 1000;
// Сколько доменов берём за тик. Проверка каждого — это до трёх DNS-запросов с таймаутом
// в 5 секунд, и упереться всем тиком в один зависший резолвер не должно.
const BATCH_SIZE = 20;

async function notifyOwner(venue, { template, payload, dedupKey }) {
  // venueLifecycle.notifyVenue уже умеет «телеграм, иначе email, иначе владельцу сервиса
  // на разбор» — правило одно на все уведомления заведению, и дублировать его тут незачем.
  await venueLifecycle.notifyVenue(pool, venue, { template, payload, dedupKey });
}

async function notifyServiceOwner({ template, payload, dedupKey }) {
  for (const ownerId of env.OWNER_TELEGRAM_IDS) {
    // eslint-disable-next-line no-await-in-loop
    await notificationModel.enqueue(pool, {
      channel: 'telegram',
      recipient: String(ownerId),
      template,
      payload,
      lang: 'ru',
      dedupKey: dedupKey ? `${dedupKey}:owner:${ownerId}` : null,
    });
  }
}

// Строка из listDueForCheck содержит и поля заведения — соберём из них то, что ждёт notifyVenue.
function venueOf(row) {
  return {
    id: row.venue_id,
    name: row.venue_name,
    lang_default: row.lang_default,
    email: row.email,
    owner_telegram_id: row.owner_telegram_id,
  };
}

async function handleTransition(row, transition) {
  const venue = venueOf(row);

  if (transition === 'verified') {
    // DNS подтверждён — домен ушёл в очередь на сертификат. Владельцу это сообщать отдельным
    // сообщением не нужно: за ним через минуты последует «домен заработал», и два уведомления
    // подряд про один и тот же домен превращают полезную новость в шум. Статус на экране
    // настроек при этом меняется сразу.
    return false;
  }

  if (transition === 'gave_up') {
    await notifyOwner(venue, {
      template: 'domain_verification_failed',
      payload: { venue_name: row.venue_name, domain: row.domain, reason: row.last_error },
      dedupKey: `domain_failed:${row.id}`,
    });
    return false;
  }

  if (transition === 'active_lost') {
    // Промт, edge case: «Заведение удалило домен из DNS, не отключив в админке — периодическая
    // проверка переводит в 'failed' через сутки, уведомляет владельца, меню продолжает работать
    // на основном домене».
    await notifyOwner(venue, {
      template: 'domain_lost',
      payload: { venue_name: row.venue_name, domain: row.domain, reason: row.last_error },
      dedupKey: `domain_lost:${row.id}:${new Date().toISOString().slice(0, 10)}`,
    });
    // Домен перестал быть активным — маршрутизация по хосту обязана узнать об этом сразу,
    // иначе веб-процесс продолжит отдавать по нему меню.
    return true;
  }

  return false;
}

async function runTick() {
  const resolver = domainVerification.createResolver();
  let routingChanged = false;

  const due = await venueDomainModel.listDueForCheck(BATCH_SIZE);
  for (const row of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { transition } = await domainVerification.processDomain(row, resolver);
      if (transition) {
        // eslint-disable-next-line no-await-in-loop
        routingChanged = (await handleTransition(row, transition)) || routingChanged;
      }
    } catch (err) {
      console.error('domainScheduler: ошибка проверки домена', row.domain, err.message);
    }
  }

  const staleBefore = new Date(Date.now() - domainVerification.ACTIVE_RECHECK_MS);
  const active = await venueDomainModel.listActiveForRecheck(BATCH_SIZE, staleBefore);
  for (const row of active) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { transition } = await domainVerification.processDomain(row, resolver);
      if (transition) {
        // eslint-disable-next-line no-await-in-loop
        routingChanged = (await handleTransition(row, transition)) || routingChanged;
      }
    } catch (err) {
      console.error('domainScheduler: ошибка перепроверки домена', row.domain, err.message);
    }
  }

  if (routingChanged) {
    await pgNotify.publishDomainChange();
  }

  return { checked: due.length + active.length, routingChanged };
}

function startDomainScheduler() {
  // Домены выключены целиком, если сервис не знает своего адреса, — проверять нечего
  // и не с чем сравнивать (см. env.customDomainsConfigured).
  if (!env.customDomainsConfigured) {
    console.log('domainScheduler: SERVICE_HOST не задан — проверка доменов не запускается');
    return { async stop() {} };
  }

  let stopped = false;
  let timer = null;
  let inFlight = null;

  async function tick() {
    inFlight = (async () => {
      try {
        await runTick();
      } catch (err) {
        console.error('domainScheduler: тик завершился ошибкой', err);
      }
    })();

    await inFlight;
    inFlight = null;
    if (!stopped) timer = setTimeout(tick, TICK_INTERVAL_MS);
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

module.exports = { startDomainScheduler, runTick, TICK_INTERVAL_MS, BATCH_SIZE };
