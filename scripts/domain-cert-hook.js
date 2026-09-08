#!/usr/bin/env node
// Промт 3.7, раздел 3. Точка, через которую скрипт выпуска сертификата сообщает в приложение,
// чем всё кончилось.
//
//   node scripts/domain-cert-hook.js list                  — домены, ждущие выпуска (по одному в строке)
//   node scripts/domain-cert-hook.js activate <domain>     — сертификат выпущен, домен в работу
//   node scripts/domain-cert-hook.js fail <domain> <текст> — выпуск не удался, записать причину
//   node scripts/domain-cert-hook.js renew-failed <domain> <текст> — не удалось ПРОДЛИТЬ
//
// Почему так, а не всё в bash: certbot требует root, а приложению root не нужен и давать его
// нельзя (прямое требование промта). Но запись в БД, очередь уведомлений и сброс кэша
// маршрутизации — это логика приложения, и дублировать её в bash через psql значило бы завести
// вторую, расходящуюся реализацию тех же переходов. Bash делает то, для чего нужен root
// (запускает certbot), Node — то, для чего нужна БД.
require('dotenv').config();

const { pool } = require('../src/config/db');
const venueDomainModel = require('../src/models/venueDomainModel');
const notificationModel = require('../src/models/notificationModel');
const venueLifecycle = require('../src/services/venueLifecycle');
const pgNotify = require('../src/services/pgNotify');
const venueModel = require('../src/models/venueModel');
const env = require('../src/config/env');

function usage() {
  console.error('использование: domain-cert-hook.js list | activate <domain> | fail <domain> [причина] | renew-failed <domain> [причина]');
  process.exit(2);
}

// Домены в статусе 'verifying' — DNS у них уже подтверждён планировщиком, осталось получить
// сертификат. Отдельной таблицы задач нет намеренно: статус И ЕСТЬ очередь, и «домен ждёт
// сертификат» не может разойтись с «в очереди есть задача на этот домен».
async function listPending() {
  const result = await pool.query(
    "SELECT domain FROM venue_domains WHERE status = 'verifying' ORDER BY created_at"
  );
  result.rows.forEach((row) => console.log(row.domain));
}

async function activate(domain) {
  const row = await venueDomainModel.findByDomain(domain);
  if (!row) {
    console.error(`domain-cert-hook: домен ${domain} не найден`);
    process.exitCode = 1;
    return;
  }

  const activated = await venueDomainModel.markActive(row.id);
  if (!activated) {
    // Переход разрешён только из 'verifying' (см. модель). Домен уже активен — это норма
    // при повторном запуске скрипта, и ошибкой считать её не надо.
    console.log(`domain-cert-hook: ${domain} уже не в состоянии ожидания сертификата (${row.status}) — ничего не меняю`);
    return;
  }

  // Маршрутизация по хосту обязана узнать о новом активном домене немедленно: без этого
  // веб-процесс будет редиректить его на сервис до следующей перезагрузки кэша.
  await pgNotify.publishDomainChange();

  const venue = await venueModel.findById(row.venue_id);
  if (venue) {
    // Промт: «после успешного выпуска домен переходит в 'active', владельцу уходит уведомление».
    await venueLifecycle.notifyVenue(pool, venue, {
      template: 'domain_active',
      payload: { venue_name: venue.name, domain },
      dedupKey: `domain_active:${row.id}`,
    });
  }

  console.log(`domain-cert-hook: ${domain} активирован`);
}

async function fail(domain, reason) {
  const row = await venueDomainModel.findByDomain(domain);
  if (!row) {
    console.error(`domain-cert-hook: домен ${domain} не найден`);
    process.exitCode = 1;
    return;
  }

  // Не переводим в 'failed': выпуск сертификата часто не удаётся с первого раза (лимиты
  // Let's Encrypt, ещё не разошедшийся DNS), и это повод повторить, а не поставить крест.
  // Домен остаётся в 'verifying', причина видна владельцу, следующий запуск скрипта попробует
  // снова. В 'failed' его переведёт планировщик, если за 48 часов ничего не выйдет.
  await venueDomainModel.recordFailure(row.id, {
    error: reason ? String(reason).slice(0, 500) : 'domains.errorDnsUnreachable',
    attempts: row.check_attempts + 1,
    nextCheckAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  console.log(`domain-cert-hook: неудача выпуска для ${domain} записана`);
}

async function renewFailed(domain, reason) {
  const row = await venueDomainModel.findByDomain(domain);
  if (!row) {
    console.error(`domain-cert-hook: домен ${domain} не найден`);
    process.exitCode = 1;
    return;
  }

  // Промт: алерт ВЛАДЕЛЬЦУ СЕРВИСА. Заведение с непродлившимся сертификатом сделать ничего
  // не может — это наша инфраструктура. Домен при этом НЕ отключаем: сертификат обычно ещё
  // действителен несколько дней, и снимать домен раньше срока значит сломать то, что работает.
  for (const ownerId of env.OWNER_TELEGRAM_IDS) {
    // eslint-disable-next-line no-await-in-loop
    await notificationModel.enqueue(pool, {
      channel: 'telegram',
      recipient: String(ownerId),
      template: 'domain_cert_renew_failed',
      payload: { domain, venue_id: row.venue_id, reason: reason ? String(reason).slice(0, 300) : '—' },
      lang: 'ru',
      // Ключ с датой: продление пробуется дважды в сутки, и одинаковый алерт каждые
      // двенадцать часов быстро перестают читать.
      dedupKey: `domain_renew_failed:${row.id}:${new Date().toISOString().slice(0, 10)}:owner:${ownerId}`,
    });
  }

  console.log(`domain-cert-hook: алерт о неудачном продлении ${domain} поставлен в очередь`);
}

(async () => {
  const [command, domain, ...rest] = process.argv.slice(2);
  const reason = rest.join(' ');

  try {
    if (command === 'list') await listPending();
    else if (command === 'activate' && domain) await activate(domain.toLowerCase());
    else if (command === 'fail' && domain) await fail(domain.toLowerCase(), reason);
    else if (command === 'renew-failed' && domain) await renewFailed(domain.toLowerCase(), reason);
    else usage();
  } finally {
    await pool.end().catch(() => {});
  }
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error('domain-cert-hook: ', err);
  process.exit(1);
});
