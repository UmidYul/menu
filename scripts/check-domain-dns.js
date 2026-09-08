// Промт 3.7, раздел 3: проверка владения доменом и правила повторных попыток.
//
//   node scripts/check-domain-dns.js
//
// Резолвер здесь ПОДСТАВНОЙ, и это единственный честный способ: настоящего DNS у выдуманного
// домена нет, а проверять логику на реальном чужом домене значит зависеть от чужой зоны.
// Подставляется ровно тот интерфейс, которым пользуется код (resolveCname/resolve4/resolveTxt),
// так что проверяется наше решение по ответу DNS, а не сам DNS.
//
// Чего эта проверка НЕ даёт: реального разрешения имён, выпуска сертификата и конфигурации
// nginx. Сквозная часть, которую можно проверить без них, — в scripts/check-custom-domains.js.
process.env.SERVER_IPV4 = process.env.SERVER_IPV4 || '203.0.113.10';
process.env.CUSTOM_DOMAIN_CNAME_TARGET = process.env.CUSTOM_DOMAIN_CNAME_TARGET || 'qr.menu';
require('dotenv').config();

const domainVerification = require('../src/services/domainVerification');
const { normalizeDomain, unicodeOf, stripWww, withWww, isWwwPair } = require('../src/utils/domainName');

let passed = 0;
let failed = 0;

function report(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}`);
    if (detail) console.error(`       ${detail}`);
  }
}

// Отдаёт ENODATA на всё, чего нет в карте, — так же, как настоящий резолвер отвечает на
// «записи такого типа у этого имени нет».
function fakeResolver(map) {
  const miss = () => {
    const err = new Error('no data');
    err.code = 'ENODATA';
    throw err;
  };
  return {
    resolveCname: async (name) => (map.cname && map.cname[name]) || miss(),
    resolve4: async (name) => (map.a && map.a[name]) || miss(),
    resolveTxt: async (name) => (map.txt && map.txt[name]) || miss(),
  };
}

const TOKEN = 'qrmenu-verify=abc123';
const D = 'menu.mykafe.uz';
const TXT_NAME = `_qrmenu.${D}`;

(async () => {
  console.log('Нормализация домена (промт: «принимать кириллицу, хранить в punycode»):');
  const normCases = [
    ['menu.mykafe.uz', 'menu.mykafe.uz', 'обычный домен'],
    ['  HTTPS://Menu.MyKafe.UZ/path?x=1  ', 'menu.mykafe.uz', 'адрес скопирован из браузера целиком'],
    ['mykafe.uz.', 'mykafe.uz', 'завершающая точка корня'],
    ['mykafe.uz:8443', 'mykafe.uz', 'порт'],
    ['localhost', null, 'одноуровневое имя'],
    ['192.168.1.1', null, 'IP-адрес'],
    ['-bad.uz', null, 'дефис в начале метки'],
    ['under_score.uz', null, 'подчёркивание'],
    ['a..b.uz', null, 'пустая метка'],
    [`x.${'a'.repeat(64)}.uz`, null, 'метка длиннее 63 символов'],
  ];
  for (const [input, expected, label] of normCases) {
    const got = normalizeDomain(input);
    report(got === expected, `${label}`, `${JSON.stringify(input)} -> ${JSON.stringify(got)}, ждали ${JSON.stringify(expected)}`);
  }

  const cyr = normalizeDomain('МЕНЮ.мойкафе.рф');
  report(cyr === 'xn--e1ane2e.xn--80akkeim9b.xn--p1ai', 'кириллица приводится к punycode', String(cyr));
  report(unicodeOf(cyr) === 'меню.мойкафе.рф', 'и разворачивается обратно для показа', unicodeOf(cyr));
  report(normalizeDomain('кафе.uz') === 'xn--80akn5b.uz', 'кириллическое имя в латинской зоне');

  report(stripWww('www.a.uz') === 'a.uz' && withWww('a.uz') === 'www.a.uz', 'www добавляется и снимается');
  report(isWwwPair('www.a.uz', 'a.uz') && !isWwwPair('a.uz', 'b.uz'), 'www-пара распознаётся');

  console.log('\nЧто считается подтверждённым доменом:');
  let r = await domainVerification.inspectDomain(D, TOKEN, fakeResolver({
    cname: { [D]: ['qr.menu'] }, txt: { [TXT_NAME]: [[TOKEN]] },
  }));
  report(r.ok, 'CNAME на наш хост + TXT с токеном');

  r = await domainVerification.inspectDomain(D, TOKEN, fakeResolver({
    a: { [D]: ['203.0.113.10'] }, txt: { [TXT_NAME]: [[TOKEN]] },
  }));
  report(r.ok, 'A-запись на наш IP вместо CNAME');

  r = await domainVerification.inspectDomain(D, TOKEN, fakeResolver({
    cname: { [D]: ['www.qr.menu'] }, txt: { [TXT_NAME]: [[TOKEN]] },
  }));
  report(r.ok, 'CNAME на www-вариант нашего хоста тоже засчитывается');

  r = await domainVerification.inspectDomain(D, TOKEN, fakeResolver({
    cname: { [D]: ['qr.menu'] }, txt: { [TXT_NAME]: [['qrmenu-verify=', 'abc123']] },
  }));
  report(r.ok, 'TXT, разбитая на куски по 255 символов, склеивается');

  r = await domainVerification.inspectDomain(D, TOKEN, fakeResolver({
    cname: { [D]: ['qr.menu'] }, txt: { [TXT_NAME]: [['v=spf1 -all'], [TOKEN]] },
  }));
  report(r.ok, 'чужие TXT в той же зоне не мешают');

  console.log('\nЧто НЕ считается — и как объясняется владельцу:');
  // Указывает на нас, но владение не доказано — это ровно тот случай, ради которого TXT
  // и существует: чужой домен, случайно направленный на наш IP, подключить нельзя.
  r = await domainVerification.inspectDomain(D, TOKEN, fakeResolver({ cname: { [D]: ['qr.menu'] } }));
  report(!r.ok && r.pointsToUs && !r.ownershipProven, 'направлен к нам, но нет TXT — не подключаем');
  report(domainVerification.failureKey(r) === 'domains.errorTxtMissing', 'причина: нет записи подтверждения');

  r = await domainVerification.inspectDomain(D, TOKEN, fakeResolver({
    a: { [D]: ['198.51.100.7'] }, txt: { [TXT_NAME]: [[TOKEN]] },
  }));
  report(!r.ok && !r.pointsToUs, 'TXT есть, но домен направлен не к нам');
  report(domainVerification.failureKey(r) === 'domains.errorNotPointingHere', 'причина: направлен не к нам');
  report(r.ips.includes('198.51.100.7'), 'видно, ЧТО именно сейчас в DNS — это показывается владельцу');
  report(r.expectedIp === '203.0.113.10', 'и видно, что ожидается');

  r = await domainVerification.inspectDomain(D, TOKEN, fakeResolver({}));
  report(domainVerification.failureKey(r) === 'domains.errorNothingConfigured', 'ничего не настроено');

  const timeout = () => { const e = new Error('timeout'); e.code = 'ETIMEOUT'; throw e; };
  r = await domainVerification.inspectDomain(D, TOKEN, {
    resolveCname: timeout, resolve4: timeout, resolveTxt: timeout,
  });
  report(r.networkError === 'ETIMEOUT', 'отказ резолвера виден отдельно от «не настроено»');
  report(
    domainVerification.failureKey(r) === 'domains.errorDnsUnreachable',
    'и объясняется как наша проблема, а не как вина владельца'
  );

  console.log('\nПравила повторных попыток:');
  // Индекс — число неудачных попыток, УЖЕ включая текущую: именно так nextDelayMs и вызывается
  // из processDomain (attempts = row.check_attempts + 1). Проверять её с нуля значило бы
  // проверять режим, в котором она не работает, — на этом первый повтор и уехал на 10 минут
  // вместо пяти.
  const delays = [1, 2, 3, 4, 5, 6, 7, 11].map(domainVerification.nextDelayMs);
  report(delays[0] === domainVerification.MIN_INTERVAL_MS, 'ПЕРВЫЙ повтор — через 5 минут (пол из промта)', `${delays[0] / 60000} мин`);
  report(delays[1] === 2 * domainVerification.MIN_INTERVAL_MS, 'второй — вдвое дольше');
  report(delays.every((d, i) => i === 0 || d >= delays[i - 1]), 'отступ растёт, а не скачет');
  report(Math.max(...delays) === domainVerification.MAX_INTERVAL_MS, 'и упирается в потолок, а не растёт вечно');
  console.log(`       ${delays.map((d) => `${Math.round(d / 60000)}м`).join(' ')}`);

  report(domainVerification.MIN_INTERVAL_MS === 5 * 60 * 1000, 'не чаще раза в 5 минут на домен');
  report(domainVerification.GIVE_UP_AFTER_MS === 48 * 60 * 60 * 1000, 'остановка через 48 часов');
  report(domainVerification.ACTIVE_GRACE_MS === 24 * 60 * 60 * 1000, 'у активного домена сутки на восстановление DNS');
  report(
    Math.ceil(domainVerification.ACTIVE_GRACE_MS / domainVerification.ACTIVE_RECHECK_MS) === 4,
    'сутки складываются из 4 неудачных перепроверок подряд'
  );
  report(domainVerification.TXT_PREFIX === '_qrmenu', 'TXT ищется на служебной метке, а не на корне зоны');

  console.log(`\nпроверок: ${passed + failed}, пройдено: ${passed}, провалов: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Скрипт упал:', err);
  process.exit(1);
});
