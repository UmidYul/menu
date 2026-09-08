const dns = require('dns');
const env = require('../config/env');
const venueDomainModel = require('../models/venueDomainModel');
const { stripWww } = require('../utils/domainName');

// Промт 3.7, раздел 3. Проверка того, что домен действительно принадлежит заведению и
// действительно указывает на нас.
//
// Проверяются ДВЕ независимые вещи, и обе обязательны:
//   1. Домен указывает на сервис — CNAME на наш хост либо A-запись на наш IP. Без этого
//      трафик до нас не дойдёт, каким бы владельцем ни был заявитель.
//   2. Владение — TXT-запись с выданным токеном. Без неё чужой домен, случайно указывающий
//      на наш IP (или указанный туда злонамеренно), мог бы быть добавлен кем угодно.
// Первое без второго — это захват чужого домена, второе без первого — домен, который не работает.

// Промт: «не чаще раза в 5 минут на домен».
const MIN_INTERVAL_MS = 5 * 60 * 1000;
// Потолок отступа: дальше растить бессмысленно — DNS распространяется часами, не сутками,
// а домен, не поднявшийся за два часа между попытками, не поднимется и за четыре.
const MAX_INTERVAL_MS = 2 * 60 * 60 * 1000;
// Промт: «остановкой через 48 часов с переводом в 'failed'».
const GIVE_UP_AFTER_MS = 48 * 60 * 60 * 1000;
// Промт, edge case: активный домен, у которого пропал DNS, переводится в 'failed' через сутки.
const ACTIVE_GRACE_MS = 24 * 60 * 60 * 1000;
// Как часто перепроверять уже активные домены. Раз в шесть часов: DNS у работающего домена
// меняется крайне редко, а сутки на реакцию (ACTIVE_GRACE_MS) дают четыре попытки заметить.
const ACTIVE_RECHECK_MS = 6 * 60 * 60 * 1000;

// Имя, под которым ищется TXT-запись. Отдельная метка, а не корень домена: на корне у зоны
// обычно уже живут SPF/DMARC и верификации других сервисов, и просить владельца дописать
// туда ещё одну строку — лишний способ сломать ему почту. Такая же схема, как у _acme-challenge.
const TXT_PREFIX = '_qrmenu';

function txtNameFor(domain) {
  return `${TXT_PREFIX}.${domain}`;
}

// Своя копия резолвера, а не dns.promises напрямую: у неё свой таймаут и её можно подменить
// в проверках, не трогая резолвер всего процесса.
function createResolver() {
  const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  return resolver;
}

async function safeResolve(fn) {
  try {
    return { records: await fn() };
  } catch (err) {
    // ENODATA/ENOTFOUND — «записи такого типа нет», нормальный ответ, а не сбой: у домена
    // может быть A вместо CNAME, и наоборот. Остальное (таймаут, SERVFAIL) — именно сбой,
    // и различать их важно: «записи нет» означает «владелец ещё не настроил», а «таймаут» —
    // «мы не смогли посмотреть», и вторая причина не должна выглядеть как вина владельца.
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return { records: [] };
    return { records: [], error: err.code || err.message };
  }
}

// Что мы видим в DNS прямо сейчас. Промт, раздел 4: «Если DNS настроен неверно — показать,
// что именно видно сейчас и что ожидается», поэтому наружу отдаётся не только вердикт,
// но и сами записи.
async function inspectDomain(domain, expectedToken, resolver = createResolver()) {
  const [cname, a, txt] = await Promise.all([
    safeResolve(() => resolver.resolveCname(domain)),
    safeResolve(() => resolver.resolve4(domain)),
    safeResolve(() => resolver.resolveTxt(txtNameFor(domain))),
  ]);

  const expectedCname = (env.CUSTOM_DOMAIN_CNAME_TARGET || '').split(':')[0];
  const expectedIp = env.SERVER_IPV4;

  const cnames = cname.records.map((r) => String(r).toLowerCase().replace(/\.$/, ''));
  const ips = a.records.map(String);
  // resolveTxt отдаёт массив массивов: одна TXT-запись может быть разбита на куски по 255
  // символов, и склеивать их обязан клиент.
  const txtValues = txt.records.map((parts) => (Array.isArray(parts) ? parts.join('') : String(parts)));

  // CNAME засчитывается и на www-вариант нашего хоста: инструкции у регистраторов разные,
  // и владелец, прописавший www.qr.menu вместо qr.menu, настроил всё правильно по существу.
  const cnameOk = Boolean(expectedCname)
    && cnames.some((value) => stripWww(value) === stripWww(expectedCname));
  const ipOk = Boolean(expectedIp) && ips.includes(expectedIp);
  const txtOk = txtValues.includes(expectedToken);

  const networkError = cname.error || a.error || txt.error || null;

  return {
    cnames,
    ips,
    txtValues,
    expectedCname,
    expectedIp,
    expectedTxtName: txtNameFor(domain),
    expectedTxtValue: expectedToken,
    pointsToUs: cnameOk || ipOk,
    ownershipProven: txtOk,
    networkError,
    ok: (cnameOk || ipOk) && txtOk,
  };
}

// Причина неудачи — КЛЮЧОМ словаря, а не текстом (правило проекта): last_error хранится в БД
// и показывается владельцу на его языке, а язык на момент проверки планировщику неизвестен.
function failureKey(inspection) {
  if (inspection.networkError) return 'domains.errorDnsUnreachable';
  if (!inspection.pointsToUs && !inspection.ownershipProven) return 'domains.errorNothingConfigured';
  if (!inspection.pointsToUs) return 'domains.errorNotPointingHere';
  return 'domains.errorTxtMissing';
}

// Экспоненциальный отступ от пола в 5 минут.
//
// attempts — число НЕУДАЧНЫХ ПОПЫТОК, УЖЕ включая текущую, поэтому вызывающий код всегда
// передаёт сюда единицу и больше. Показатель степени, соответственно, attempts - 1: иначе
// первый повтор пришёлся бы на 10 минут, а пол в 5 минут, который требует промт, не наступал
// бы никогда — ровно это и всплыло на прогоне планировщика по живой БД.
function nextDelayMs(attempts) {
  return Math.min(MIN_INTERVAL_MS * (2 ** Math.max(0, attempts - 1)), MAX_INTERVAL_MS);
}

// Обрабатывает один домен: проверяет DNS и двигает его по статусам. Возвращает
// { row, inspection, transition } — transition говорит вызывающему коду, надо ли слать
// уведомление, чтобы решение «что случилось» принималось в одном месте.
async function processDomain(row, resolver) {
  const inspection = await inspectDomain(row.domain, row.verification_token, resolver);
  const now = Date.now();

  if (inspection.ok) {
    if (row.status === 'active') {
      // Активный домен просто подтверждает, что с ним всё в порядке: сбрасываем счётчик
      // неудач, чтобы вчерашняя временная пропажа DNS не приближала его к 'failed'.
      const updated = await venueDomainModel.recordFailure(row.id, {
        error: null, attempts: 0, nextCheckAt: new Date(now + ACTIVE_RECHECK_MS),
      });
      return { row: updated, inspection, transition: null };
    }
    if (row.status === 'verifying') {
      // DNS в порядке, но домен всё ещё ждёт сертификат: его выпускает отдельный скрипт
      // (scripts/issue-cert.sh), и торопить его отсюда нечем. Просто отодвигаем проверку.
      const updated = await venueDomainModel.recordFailure(row.id, {
        error: null, attempts: 0, nextCheckAt: new Date(now + MIN_INTERVAL_MS),
      });
      return { row: updated, inspection, transition: null };
    }
    // pending -> verifying: DNS подтверждён, домен встаёт в очередь на выпуск сертификата.
    const updated = await venueDomainModel.markVerifying(row.id);
    return { row: updated || row, inspection, transition: updated ? 'verified' : null };
  }

  const errorKey = failureKey(inspection);
  const addedAt = new Date(row.created_at).getTime();

  // Активный домен, у которого сломался DNS: сутки на восстановление, потом 'failed'.
  // Меню при этом продолжает работать на основном адресе — оно и не переставало.
  //
  // Сутки считаются подряд идущими неудачами, а не разницей дат: check_attempts обнуляется
  // при каждой успешной проверке (см. ветку inspection.ok выше), так что «четыре неудачи
  // подряд по шесть часов» и есть «сутки без DNS». Считать по датам пришлось бы отдельно
  // хранить момент, когда всё сломалось, — ещё одна колонка ради того же самого числа.
  if (row.status === 'active') {
    const attempts = row.check_attempts + 1;
    if (attempts >= Math.ceil(ACTIVE_GRACE_MS / ACTIVE_RECHECK_MS)) {
      const updated = await venueDomainModel.markFailed(row.id, errorKey);
      return { row: updated || row, inspection, transition: 'active_lost' };
    }
    const updated = await venueDomainModel.recordFailure(row.id, {
      error: errorKey, attempts, nextCheckAt: new Date(now + ACTIVE_RECHECK_MS),
    });
    return { row: updated, inspection, transition: null };
  }

  // Промт: остановка через 48 часов после добавления.
  if (now - addedAt >= GIVE_UP_AFTER_MS) {
    const updated = await venueDomainModel.markFailed(row.id, errorKey);
    return { row: updated || row, inspection, transition: 'gave_up' };
  }

  const attempts = row.check_attempts + 1;
  const updated = await venueDomainModel.recordFailure(row.id, {
    error: errorKey, attempts, nextCheckAt: new Date(now + nextDelayMs(attempts)),
  });
  return { row: updated, inspection, transition: null };
}

module.exports = {
  inspectDomain,
  processDomain,
  failureKey,
  nextDelayMs,
  txtNameFor,
  createResolver,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  GIVE_UP_AFTER_MS,
  ACTIVE_GRACE_MS,
  ACTIVE_RECHECK_MS,
  TXT_PREFIX,
};
