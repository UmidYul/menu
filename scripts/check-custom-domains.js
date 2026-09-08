// Промт 3.7. DEFINITION OF DONE: «домен добавляется, проверяется, получает сертификат, меню
// открывается по нему, админка на нём недоступна, SEO-теги указывают на кастомный домен».
//
//   node scripts/check-custom-domains.js
//
// Проверка ЭМПИРИЧЕСКАЯ и сквозная: скрипт заводит заведение с собственным доменом и алиасом,
// ходит на приложение с подменённым заголовком Host и проверяет, что получилось на самом деле.
// Подмена Host — то же самое, что делает браузер гостя: приложение отличает свой хост от чужого
// ровно по этому заголовку, других источников у него нет.
//
// Чего эта проверка НЕ даёт и что осталось непроверенным: выпуск сертификата certbot'ом,
// конфигурация nginx и реальное разрешение DNS. Ни того, ни другого, ни третьего на машине
// разработки нет. Логика проверки DNS проверяется отдельно, на подставном резолвере
// (scripts/check-domain-dns.js), а certbot и nginx остаются на ответственности README.
require('dotenv').config();

const http = require('node:http');
const bcrypt = require('bcrypt');
const { pool } = require('../src/config/db');
const env = require('../src/config/env');
const pgNotify = require('../src/services/pgNotify');
const domainCache = require('../src/services/domainCache');
const domainScheduler = require('../bot/worker/domainScheduler');

const BASE = env.APP_BASE_URL || 'http://localhost:3000';
const BASE_URL = new URL(BASE);
const SUFFIX = Date.now().toString(36);
const LOGIN = `cd_probe_${SUFFIX}`;
const PASSWORD = 'CustomDomain123';
const DOMAIN = `menu.probe-${SUFFIX}.uz`;
const WWW_DOMAIN = `www.${DOMAIN}`;
const FOREIGN_DOMAIN = `menu.foreign-${SUFFIX}.uz`;

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

// Клиент на node:http, а НЕ на fetch. undici (fetch в Node) считает Host запрещённым
// заголовком и молча его выбрасывает — запрос уходит на localhost, приложение видит свой
// собственный хост, и вся проверка кастомных доменов проходит вхолостую, показывая зелёные
// галочки там, где ничего не проверено. node:http позволяет задать Host явно, а это ровно то,
// что делает браузер гостя, пришедшего по домену заведения.
function makeClient() {
  const jar = new Map();
  const cookieHeader = () => Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

  function storeCookies(setCookie) {
    setCookie.forEach((line) => {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    });
  }

  // host — подменённый заголовок Host. Именно по нему приложение решает, кастомный это домен
  // или свой, так что «зайти по домену заведения» здесь означает ровно это.
  function request(method, path, { body, host } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Cookie: cookieHeader() };
      if (host) headers.Host = host;
      let payload = null;
      if (body) {
        payload = new URLSearchParams(body).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request({
        hostname: BASE_URL.hostname,
        port: BASE_URL.port || 80,
        path,
        method,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const setCookie = res.headers['set-cookie'] || [];
          storeCookies(setCookie);
          resolve({
            status: res.statusCode,
            location: res.headers.location || null,
            setCookie,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return { request };
}

async function csrfFrom(client, path) {
  const page = await client.request('GET', path);
  const match = /name="_csrf" value="([^"]+)"/.exec(page.text);
  return match ? match[1] : null;
}

async function cleanup(ids) {
  await pool.query('DELETE FROM admin_action_logs WHERE venue_id = ANY($1) OR admin_id = $2', [ids.venueIds, ids.adminId]);
  await pool.query('DELETE FROM venue_domains WHERE venue_id = ANY($1)', [ids.venueIds]);
  await pool.query('DELETE FROM items WHERE category_id IN (SELECT id FROM categories WHERE venue_id = ANY($1))', [ids.venueIds]);
  await pool.query('DELETE FROM categories WHERE venue_id = ANY($1)', [ids.venueIds]);
  await pool.query('DELETE FROM venue_page_views WHERE venue_id = ANY($1)', [ids.venueIds]);
  await pool.query('DELETE FROM admin_venues WHERE venue_id = ANY($1) OR admin_id = $2', [ids.venueIds, ids.adminId]);
  await pool.query('DELETE FROM admins WHERE id = $1', [ids.adminId]);
  await pool.query('DELETE FROM venues WHERE id = ANY($1)', [ids.venueIds]);
  await pgNotify.publishDomainChange().catch(() => {});
}

(async () => {
  console.log(`Проверка своих доменов заведений на ${BASE}`);
  console.log(`Свой хост сервиса: ${env.SERVICE_HOST}\n`);

  // Заведение с меню — чтобы было что показывать по домену.
  const venue = (await pool.query(
    `INSERT INTO venues (slug, name, lang_default, status, is_active, show_powered_by)
     VALUES ($1, $2, 'ru', 'active', true, true) RETURNING id, slug, name`,
    [`cd-${SUFFIX}`, `ДОМЕН-${SUFFIX}`]
  )).rows[0];
  const category = (await pool.query(
    'INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $2, 0) RETURNING id',
    [venue.id, `КАТ-${SUFFIX}`]
  )).rows[0];
  await pool.query(
    "INSERT INTO items (category_id, name_ru, name_uz, price, currency, sort_order) VALUES ($1, $2, $2, 42000, 'UZS', 0)",
    [category.id, `БЛЮДО-${SUFFIX}`]
  );

  // Второе заведение — его меню НЕ должно быть видно с чужого домена.
  const other = (await pool.query(
    `INSERT INTO venues (slug, name, lang_default, status, is_active, show_powered_by)
     VALUES ($1, $2, 'ru', 'active', true, true) RETURNING id, slug, name`,
    [`cd-other-${SUFFIX}`, `ЧУЖОЕ-${SUFFIX}`]
  )).rows[0];

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const admin = (await pool.query(
    `INSERT INTO admins (venue_id, login, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, 'venue_admin', false) RETURNING id`,
    [venue.id, LOGIN, passwordHash]
  )).rows[0];
  await pool.query("INSERT INTO admin_venues (admin_id, venue_id, role) VALUES ($1, $2, 'owner')", [admin.id, venue.id]);

  const ids = { adminId: admin.id, venueIds: [venue.id, other.id] };

  try {
    const client = makeClient();
    const csrfLogin = await csrfFrom(client, '/admin/login');
    const login = await client.request('POST', '/admin/login', { body: { _csrf: csrfLogin, login: LOGIN, password: PASSWORD } });
    if (login.status !== 302) {
      console.error('Не удалось войти — проверка невозможна.', login.status);
      await cleanup(ids);
      process.exit(1);
    }

    // --- раздел 4: админка -------------------------------------------------------------------
    console.log('Админка «Свой домен»:');
    const csrf = await csrfFrom(client, '/admin/domain');
    report(Boolean(csrf), 'страница /admin/domain открывается');

    const invalidCases = [
      { value: 'garbage', expect: 'domains.errorInvalid', label: 'не домен' },
      { value: '1.2.3.4', expect: 'domains.errorInvalid', label: 'IP-адрес' },
      { value: 'under_score.uz', expect: 'domains.errorInvalid', label: 'подчёркивание' },
      // www-вариант собственного хоста: в разработке SERVICE_HOST — это 'localhost',
      // одноуровневое имя, которое отсеивается раньше, ещё как «не домен». С www меток две,
      // значение доходит до проверки на собственный адрес — а перехват www сервиса и есть
      // тот случай, ради которого проверка существует.
      { value: `www.${(env.SERVICE_HOST || 'localhost:3000').split(':')[0]}`, expect: 'domains.errorServiceHost', label: 'www-адрес самого сервиса' },
    ];
    for (const testCase of invalidCases) {
      // eslint-disable-next-line no-await-in-loop
      const response = await client.request('POST', '/admin/domain', { body: { _csrf: csrf, domain: testCase.value } });
      report(
        response.status === 302 && String(response.location).includes(testCase.expect),
        `отклоняется: ${testCase.label}`,
        `${response.status} -> ${response.location}`
      );
    }

    // Промт: «Кириллические домены — принимать, но хранить в punycode».
    const cyrillic = await client.request('POST', '/admin/domain', { body: { _csrf: csrf, domain: 'МЕНЮ.пробa-кафе.уз' } });
    const cyrRow = (await pool.query('SELECT domain FROM venue_domains WHERE venue_id = $1', [venue.id])).rows[0];
    report(
      cyrillic.status === 302 && cyrRow && cyrRow.domain.startsWith('xn--'),
      'кириллический домен принят и сохранён в punycode',
      cyrRow ? cyrRow.domain : 'строки нет'
    );
    await pool.query('DELETE FROM venue_domains WHERE venue_id = $1', [venue.id]);

    // Нормальное добавление с алиасом www одной галочкой.
    const added = await client.request('POST', '/admin/domain', {
      body: { _csrf: csrf, domain: DOMAIN.toUpperCase(), with_www: '1' },
    });
    const rows = (await pool.query(
      'SELECT domain, status, is_primary, verification_token FROM venue_domains WHERE venue_id = $1 ORDER BY is_primary DESC',
      [venue.id]
    )).rows;
    report(added.status === 302 && rows.length === 2, 'домен и www-алиас добавлены одной формой', `строк: ${rows.length}`);
    report(rows[0] && rows[0].domain === DOMAIN, 'адрес приведён к нижнему регистру', rows[0] && rows[0].domain);
    report(rows[0] && rows[0].status === 'pending', 'новый домен ждёт настройки DNS');
    report(rows[0] && rows[0].verification_token.startsWith('qrmenu-verify='), 'выдан токен подтверждения');
    report(rows[1] && rows[1].domain === WWW_DOMAIN && rows[1].is_primary === false, 'www — алиас, не основной');

    // Третий домен не влезает: промт разрешает максимум два.
    const third = await client.request('POST', '/admin/domain', { body: { _csrf: csrf, domain: `third-${SUFFIX}.uz` } });
    report(
      third.status === 302 && String(third.location).includes('errorTooMany'),
      'третий домен отклонён: максимум два на заведение',
      String(third.location)
    );

    // Промт: «Домен уже используется другим заведением — ошибка на этапе ДОБАВЛЕНИЯ».
    await pool.query(
      "INSERT INTO venue_domains (venue_id, domain, verification_token, is_primary, status) VALUES ($1, $2, 'qrmenu-verify=x', true, 'active')",
      [other.id, FOREIGN_DOMAIN]
    );
    await pool.query('DELETE FROM venue_domains WHERE venue_id = $1 AND is_primary = false', [venue.id]);
    const taken = await client.request('POST', '/admin/domain', { body: { _csrf: csrf, domain: FOREIGN_DOMAIN } });
    report(
      taken.status === 302 && String(taken.location).includes('errorTaken'),
      'занятый другим заведением домен отклонён при добавлении',
      String(taken.location)
    );

    // Страница объясняет каждый статус и показывает, что прописать в DNS.
    const page = await client.request('GET', '/admin/domain');
    report(page.text.includes('ждём настройку DNS'), 'статус переведён человеческим языком');
    report(/Домен добавлен\. Осталось прописать/.test(page.text), 'объяснение статуса на странице (не голое «pending»)');
    report(page.text.includes('_qrmenu.'), 'показано имя TXT-записи для подтверждения');
    report(page.text.includes(rows[0].verification_token), 'показано значение TXT-записи');
    report(/Что видно в DNS сейчас/.test(page.text), 'показано, что видно в DNS сейчас');
    report(!/domains\.[a-zA-Z]/.test(page.text), 'на странице нет непереведённых ключей словаря');

    // Промт: «кнопка „Проверить сейчас“ (лимит 1 раз в минуту)».
    const domainId = (await pool.query('SELECT id FROM venue_domains WHERE venue_id = $1 AND is_primary', [venue.id])).rows[0].id;
    const check1 = await client.request('POST', `/admin/domain/${domainId}/check`, { body: { _csrf: csrf } });
    const check2 = await client.request('POST', `/admin/domain/${domainId}/check`, { body: { _csrf: csrf } });
    report(
      check1.status === 302 && String(check1.location).includes('checkNowQueued'),
      'первая проверка принята'
    );
    report(
      check2.status === 302 && String(check2.location).includes('checkNowTooOften'),
      'вторая проверка подряд отбита лимитом «раз в минуту»',
      String(check2.location)
    );

    // --- раздел 2: маршрутизация по хосту ------------------------------------------------------
    console.log('\nМаршрутизация по хосту:');
    await pool.query("UPDATE venue_domains SET status = 'active' WHERE venue_id = $1", [venue.id]);
    await pool.query(
      "INSERT INTO venue_domains (venue_id, domain, verification_token, is_primary, status) VALUES ($1, $2, 'qrmenu-verify=y', false, 'active')",
      [venue.id, WWW_DOMAIN]
    );
    await pgNotify.publishDomainChange();

    const guest = makeClient();
    // NOTIFY доходит до веб-процесса асинхронно, а этот скрипт — отдельный процесс: его
    // собственный domainCache веб-серверу ни при чём. Дожидаемся, пока СЕРВЕР перечитает
    // список, а не спим фиксированное время: на медленной машине сон оказался бы коротким,
    // на быстрой — впустую длинным, и в обоих случаях проверка стала бы плавающей.
    async function waitForRouting(host, expectStatus) {
      for (let i = 0; i < 40; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const probe = await guest.request('GET', '/', { host });
        if (probe.status === expectStatus) return probe;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      return guest.request('GET', '/', { host });
    }

    const root = await waitForRouting(DOMAIN, 200);
    report(root.status === 200, 'корень своего домена отдаёт меню', `статус ${root.status}`);
    report(root.text.includes(`БЛЮДО-${SUFFIX}`), 'на нём видно позиции этого заведения');
    report(!root.text.includes(`ЧУЖОЕ-${SUFFIX}`), 'и не видно чужого заведения');

    // Промт: «Cookie сессии не должны выставляться на кастомных доменах».
    const sessionCookies = root.setCookie.filter((c) => c.startsWith('qrmenu.sid'));
    report(sessionCookies.length === 0, 'cookie сессии на своём домене не выставляется', JSON.stringify(root.setCookie));

    // Промт: «На кастомном домене доступно ТОЛЬКО публичное меню. Админка, лендинг
    // и суперадминка — редирект на основной домен».
    for (const path of ['/admin', '/admin/login', '/superadmin/venues', '/apply', `/menu/${other.slug}`]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await guest.request('GET', path, { host: DOMAIN });
      report(
        response.status === 301 && !String(response.location).includes(DOMAIN),
        `${path} на своём домене уводит на адрес сервиса`,
        `${response.status} -> ${response.location}`
      );
    }

    // Промт: «Редирект с www на без-www — 301».
    const www = await guest.request('GET', '/', { host: WWW_DOMAIN });
    report(
      www.status === 301 && String(www.location).includes(`//${DOMAIN}/`),
      'www-алиас отдаёт 301 на основной домен',
      `${www.status} -> ${www.location}`
    );

    // Промт, edge case: «Кто-то направил свой домен на твой IP без добавления в систему —
    // не отдавать чужое меню».
    const unknown = await guest.request('GET', '/', { host: `unknown-${SUFFIX}.example.com` });
    report(
      unknown.status === 301 && !unknown.text.includes(`БЛЮДО-${SUFFIX}`),
      'неизвестный домен не получает ничьё меню',
      `${unknown.status} -> ${unknown.location}`
    );

    // ACME-челлендж обязан проходить на кастомном домене всегда, иначе сертификат
    // не выпустится и не продлится.
    const acme = await guest.request('GET', '/.well-known/acme-challenge/testtoken', { host: DOMAIN });
    report(acme.status !== 301, 'ACME-челлендж не редиректится с кастомного домена', `статус ${acme.status}`);

    // --- SEO ---------------------------------------------------------------------------------
    console.log('\nSEO на своём домене:');
    report(
      root.text.includes(`<link rel="canonical" href="http://${DOMAIN}/">`),
      'canonical указывает на свой домен и на его корень'
    );
    report(
      root.text.includes(`hreflang="ru" href="http://${DOMAIN}/?lang=ru"`),
      'hreflang указывает на свой домен'
    );
    report(root.text.includes(`http://${DOMAIN}/og/`), 'og:image ведёт на свой домен');
    report(
      !root.text.includes(`/menu/${venue.slug}"`) || root.text.includes(`http://${DOMAIN}/`),
      'канонический адрес не остался на пути сервиса'
    );

    const serviceRoot = await guest.request('GET', `/menu/${venue.slug}`);
    report(
      serviceRoot.text.includes(`/menu/${venue.slug}`) && !serviceRoot.text.includes(`canonical" href="http://${DOMAIN}`),
      'на адресе сервиса canonical остаётся адресом сервиса (кэш не смешался)'
    );
    // Повторно — теперь обе версии заведомо из кэша.
    const rootCached = await guest.request('GET', '/', { host: DOMAIN });
    const serviceCached = await guest.request('GET', `/menu/${venue.slug}`);
    report(
      rootCached.text.includes(`canonical" href="http://${DOMAIN}/"`)
        && !serviceCached.text.includes(`canonical" href="http://${DOMAIN}`),
      'после кэширования домены по-прежнему не смешиваются'
    );

    const sitemap = await guest.request('GET', '/sitemap.xml', { host: DOMAIN });
    report(sitemap.status === 200 && sitemap.text.includes(`<loc>http://${DOMAIN}/</loc>`), 'sitemap указывает на свой домен');
    report(!sitemap.text.includes(`/menu/${other.slug}`), 'sitemap своего домена не перечисляет чужие меню');

    const robots = await guest.request('GET', '/robots.txt', { host: DOMAIN });
    report(robots.text.includes(`Sitemap: http://${DOMAIN}/sitemap.xml`), 'robots.txt ссылается на свой sitemap');

    const manifest = await guest.request('GET', `/menu/${venue.slug}/manifest.webmanifest`, { host: DOMAIN });
    const manifestJson = JSON.parse(manifest.text);
    report(manifestJson.start_url === '/?src=pwa' && manifestJson.scope === '/', 'манифест PWA стартует с корня своего домена');
    const manifestService = await guest.request('GET', `/menu/${venue.slug}/manifest.webmanifest`);
    report(
      JSON.parse(manifestService.text).scope === `/menu/${venue.slug}`,
      'на адресе сервиса манифест прежний (кэш манифеста тоже не смешался)'
    );

    // --- edge cases --------------------------------------------------------------------------
    console.log('\nEdge cases:');
    // Промт: «Домен указан на сервис, но заведение в suspended — показывается страница-заглушка».
    await pool.query("UPDATE venues SET status = 'suspended' WHERE id = $1", [venue.id]);
    const suspended = await guest.request('GET', '/', { host: DOMAIN });
    report(
      suspended.status === 200 && !suspended.text.includes(`БЛЮДО-${SUFFIX}`),
      'при suspended по домену отдаётся заглушка, а не меню',
      `статус ${suspended.status}`
    );
    await pool.query("UPDATE venues SET status = 'active' WHERE id = $1", [venue.id]);

    // Отключение домена должно немедленно прекратить маршрутизацию по нему.
    const csrf2 = await csrfFrom(client, '/admin/domain');
    const disable = await client.request('POST', `/admin/domain/${domainId}/disable`, { body: { _csrf: csrf2 } });
    report(disable.status === 302, 'домен отключается из админки', `статус ${disable.status}`);
    const afterDisable = await waitForRouting(DOMAIN, 301);
    report(
      afterDisable.status === 301 && !afterDisable.text.includes(`БЛЮДО-${SUFFIX}`),
      'отключённый домен сразу перестаёт отдавать меню',
      `статус ${afterDisable.status}`
    );

    // Меню при этом продолжает работать на адресе сервиса — это и есть смысл всех «меню
    // продолжает работать на основном домене» из edge cases промта.
    const stillWorks = await guest.request('GET', `/menu/${venue.slug}`);
    report(
      stillWorks.status === 200 && stillWorks.text.includes(`БЛЮДО-${SUFFIX}`),
      'меню продолжает работать на адресе сервиса'
    );

    // --- планировщик проверок ------------------------------------------------------------
    // Логика решения по ответу DNS проверяется отдельно, на подставном резолвере
    // (scripts/check-domain-dns.js). Здесь проверяется ДРУГОЕ: что тик планировщика реально
    // ходит в БД, записывает результат и уважает собственный срок. Именно этот прогон поймал
    // сдвиг на единицу, из-за которого первый повтор уезжал на 10 минут вместо пяти, —
    // на подставном резолвере он был не виден, потому что там функция вызывалась с нуля,
    // а в жизни она вызывается с единицы.
    console.log('\nПланировщик проверок:');
    // Своё заведение под планировщик: у обоих предыдущих основной домен уже занят
    // (у одного — рабочий, у второго — тот, на котором проверялась ошибка «уже используется»),
    // а индекс (venue_id, is_primary) второго основного не допустит.
    const tickVenue = (await pool.query(
      `INSERT INTO venues (slug, name, lang_default, status, is_active, show_powered_by)
       VALUES ($1, $2, 'ru', 'active', true, true) RETURNING id`,
      [`cd-tick-${SUFFIX}`, `ТИК-${SUFFIX}`]
    )).rows[0];
    ids.venueIds.push(tickVenue.id);

    const tickDomain = `menu.tick-${SUFFIX}.uz`;
    const tickRow = (await pool.query(
      `INSERT INTO venue_domains (venue_id, domain, verification_token, is_primary, status)
       VALUES ($1, $2, 'qrmenu-verify=tick', true, 'pending') RETURNING id`,
      [tickVenue.id, tickDomain]
    )).rows[0];

    const first = await domainScheduler.runTick();
    const afterFirst = (await pool.query(
      'SELECT status, check_attempts, last_error, last_check_at, next_check_at FROM venue_domains WHERE id = $1',
      [tickRow.id]
    )).rows[0];
    const delayMin = Math.round((new Date(afterFirst.next_check_at) - Date.now()) / 60000);

    report(first.checked >= 1 && afterFirst.last_check_at !== null, 'тик реально проверил домен');
    report(afterFirst.check_attempts === 1, 'счётчик попыток вырос', `attempts=${afterFirst.check_attempts}`);
    report(
      String(afterFirst.last_error).startsWith('domains.'),
      'причина неудачи записана КЛЮЧОМ словаря, а не текстом',
      String(afterFirst.last_error)
    );
    report(delayMin === 5, 'ПЕРВЫЙ повтор назначен через 5 минут — пол из промта', `${delayMin} мин`);
    report(afterFirst.status === 'pending', 'домен остаётся в ожидании, а не падает сразу в failed');

    const second = await domainScheduler.runTick();
    const afterSecond = (await pool.query('SELECT check_attempts FROM venue_domains WHERE id = $1', [tickRow.id])).rows[0];
    report(
      afterSecond.check_attempts === 1,
      'до срока следующей проверки планировщик домен не трогает',
      `проверено за тик: ${second.checked}, attempts=${afterSecond.check_attempts}`
    );

    await pool.query("UPDATE venue_domains SET next_check_at = now() - interval '1 minute' WHERE id = $1", [tickRow.id]);
    await domainScheduler.runTick();
    const afterThird = (await pool.query('SELECT check_attempts, next_check_at FROM venue_domains WHERE id = $1', [tickRow.id])).rows[0];
    report(
      afterThird.check_attempts === 2
        && Math.round((new Date(afterThird.next_check_at) - Date.now()) / 60000) === 10,
      'следующий отступ вдвое длиннее предыдущего'
    );

    // Промт: «остановка через 48 часов с переводом в failed».
    await pool.query(
      "UPDATE venue_domains SET created_at = now() - interval '49 hours', next_check_at = now() - interval '1 minute' WHERE id = $1",
      [tickRow.id]
    );
    await domainScheduler.runTick();
    const afterGiveUp = (await pool.query('SELECT status FROM venue_domains WHERE id = $1', [tickRow.id])).rows[0];
    report(afterGiveUp.status === 'failed', 'через 48 часов домен уходит в failed', afterGiveUp.status);

    // Журнал действий: подключение и отключение домена должны быть видны.
    const logs = await pool.query(
      "SELECT action_type, details FROM admin_action_logs WHERE venue_id = $1 AND entity_type = 'domain' ORDER BY id",
      [venue.id]
    );
    report(
      logs.rows.some((r) => r.action_type === 'create') && logs.rows.some((r) => r.action_type === 'delete'),
      'подключение и отключение домена записаны в журнал',
      JSON.stringify(logs.rows.map((r) => r.action_type))
    );
  } finally {
    await cleanup(ids);
  }

  console.log(`\nпроверок: ${passed + failed}, пройдено: ${passed}, провалов: ${failed}`);
  if (failed > 0) process.exitCode = 1;
  process.exit(process.exitCode || 0);
})().catch(async (err) => {
  console.error('Скрипт упал:', err);
  process.exit(1);
});
