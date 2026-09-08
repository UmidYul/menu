// Промт 3.6, разделы 4 и 5: сводный экран сети и копирование меню между заведениями.
//
//   node scripts/check-venue-network.js
//
// Проверка ЭМПИРИЧЕСКАЯ: скрипт заводит аккаунт с двумя заведениями, кладёт в первое меню
// с фото, опциями и стоп-листом, открывает сводку, копирует меню во второе заведение и
// сверяет результат — и в HTML, и в БД, и на диске.
//
// Отдельно от check-venue-isolation.js: тот отвечает на вопрос «не течёт ли», этот — на вопрос
// «работает ли». Главное, что здесь проверяется руками: фото скопированы ФИЗИЧЕСКИ (промт
// требует именно этого), то есть у копии свой файл, а не ссылка на файл соседа.
require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
const { pool } = require('../src/config/db');
const env = require('../src/config/env');

const BASE = env.APP_BASE_URL || 'http://localhost:3000';
const UPLOADS_ROOT = path.join(__dirname, '..', 'public', 'uploads');
const SUFFIX = Date.now().toString(36);
const LOGIN = `net_probe_${SUFFIX}`;
const PASSWORD = 'NetworkProbe123';

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

function makeClient() {
  const jar = new Map();
  const cookieHeader = () => Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

  function storeCookies(response) {
    const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    raw.forEach((line) => {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    });
  }

  async function request(method, pathname, body) {
    const headers = { Cookie: cookieHeader() };
    let payload;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    }
    const response = await fetch(`${BASE}${pathname}`, { method, headers, body: payload, redirect: 'manual' });
    storeCookies(response);
    const text = await response.text().catch(() => '');
    return { status: response.status, location: response.headers.get('location'), text };
  }

  return { request };
}

async function csrfFrom(client, pathname) {
  const page = await client.request('GET', pathname);
  const match = /name="_csrf" value="([^"]+)"/.exec(page.text);
  return match ? match[1] : null;
}

// slug — ЛАТИНИЦЕЙ (отдельным параметром от названия): валидатор заведения требует
// `^[a-z0-9]+(-[a-z0-9]+)*$`, и подсовывать в обход него кириллический slug — значит проверять
// состояние, которого в приложении не бывает. Название при этом остаётся кириллическим:
// именно по нему проверки ищут своё и чужое на экранах.
async function createVenue(slugPart, label) {
  const venue = await pool.query(
    `INSERT INTO venues (slug, name, lang_default, status, is_active, show_powered_by, subscription_until)
     VALUES ($1, $2, 'ru', 'active', true, true, CURRENT_DATE + 30) RETURNING id, slug, name`,
    [`net-${slugPart}-${SUFFIX}`, `СЕТЬ-${label}-${SUFFIX}`]
  );
  return venue.rows[0];
}

// Настоящий webp того же вида, что кладёт photoService: копирование должно перенести байты,
// и подсунуть вместо картинки текстовый файл здесь нельзя — проверка перестала бы быть честной.
async function writePhoto(venueId, token, suffix) {
  const dir = path.join(UPLOADS_ROOT, String(venueId));
  await fs.mkdir(dir, { recursive: true });
  const buffer = await sharp({
    create: {
      width: 40, height: 40, channels: 3, background: { r: 198, g: 93, b: 66 },
    },
  }).webp().toBuffer();
  const filename = `${token}-${suffix}.webp`;
  await fs.writeFile(path.join(dir, filename), buffer);
  return `/uploads/${venueId}/${filename}`;
}

async function cleanup(ids) {
  await pool.query('DELETE FROM admin_action_logs WHERE venue_id = ANY($1) OR admin_id = $2', [ids.venueIds, ids.adminId]);
  await pool.query(`DELETE FROM item_options WHERE group_id IN (
      SELECT g.id FROM item_option_groups g JOIN items i ON i.id = g.item_id
      JOIN categories c ON c.id = i.category_id WHERE c.venue_id = ANY($1))`, [ids.venueIds]);
  await pool.query(`DELETE FROM item_option_groups WHERE item_id IN (
      SELECT i.id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id = ANY($1))`, [ids.venueIds]);
  await pool.query('DELETE FROM items WHERE category_id IN (SELECT id FROM categories WHERE venue_id = ANY($1))', [ids.venueIds]);
  await pool.query('DELETE FROM categories WHERE venue_id = ANY($1)', [ids.venueIds]);
  await pool.query('DELETE FROM venue_page_views WHERE venue_id = ANY($1)', [ids.venueIds]);
  await pool.query('DELETE FROM menu_versions WHERE venue_id = ANY($1)', [ids.venueIds]).catch(() => {});
  await pool.query('DELETE FROM admin_venues WHERE venue_id = ANY($1) OR admin_id = $2', [ids.venueIds, ids.adminId]);
  await pool.query('DELETE FROM admins WHERE id = $1', [ids.adminId]);
  await pool.query('DELETE FROM venues WHERE id = ANY($1)', [ids.venueIds]);
  for (const venueId of ids.venueIds) {
    await fs.rm(path.join(UPLOADS_ROOT, String(venueId)), { recursive: true, force: true }).catch(() => {});
  }
}

(async () => {
  console.log(`Проверка сводного экрана и копирования меню на ${BASE}`);

  const source = await createVenue('source', 'ИСТОЧНИК');
  const target = await createVenue('target', 'ЦЕЛЬ');

  // Меню источника: две категории, три позиции, у одной — фото, опции и стоп-лист.
  const catA = await pool.query(
    `INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $2, 0) RETURNING id`,
    [source.id, `КАТ-ПЕРВАЯ-${SUFFIX}`]
  );
  const catB = await pool.query(
    `INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $2, 1) RETURNING id`,
    [source.id, `КАТ-ВТОРАЯ-${SUFFIX}`]
  );

  const photoToken = `net${SUFFIX}`;
  const photoUrl = await writePhoto(source.id, photoToken, 'full');
  const thumbUrl = await writePhoto(source.id, photoToken, 'thumb');

  const itemWithPhoto = await pool.query(
    `INSERT INTO items (category_id, name_ru, name_uz, price, old_price, currency, photo_url, photo_thumb_url, sort_order)
     VALUES ($1, $2, $2, 50000, 65000, 'UZS', $3, $4, 0) RETURNING id`,
    [catA.rows[0].id, `БЛЮДО-С-ФОТО-${SUFFIX}`, photoUrl, thumbUrl]
  );
  await pool.query(
    `INSERT INTO items (category_id, name_ru, name_uz, price, currency, is_available, sort_order)
     VALUES ($1, $2, $2, 30000, 'UZS', false, 1)`,
    [catA.rows[0].id, `БЛЮДО-В-СТОПЕ-${SUFFIX}`]
  );
  await pool.query(
    `INSERT INTO items (category_id, name_ru, name_uz, price, currency, sort_order)
     VALUES ($1, $2, $2, 12000, 'UZS', 0)`,
    [catB.rows[0].id, `БЛЮДО-ТРЕТЬЕ-${SUFFIX}`]
  );

  const group = await pool.query(
    `INSERT INTO item_option_groups (item_id, name_ru, name_uz, selection, is_required, min_select, max_select, sort_order)
     VALUES ($1, $2, $2, 'single', true, 1, 1, 0) RETURNING id`,
    [itemWithPhoto.rows[0].id, `РАЗМЕР-${SUFFIX}`]
  );
  await pool.query(
    `INSERT INTO item_options (group_id, name_ru, name_uz, price_delta, sort_order)
     VALUES ($1, $2, $2, 7000, 0)`,
    [group.rows[0].id, `БОЛЬШОЙ-${SUFFIX}`]
  );

  // Просмотры за неделю — чтобы в сводке и на графике было ненулевое число.
  await pool.query(
    `INSERT INTO venue_page_views (venue_id, viewed_on, view_count) VALUES ($1, CURRENT_DATE, 17)`,
    [source.id]
  );
  await pool.query(
    `INSERT INTO venue_page_views (venue_id, viewed_on, view_count) VALUES ($1, CURRENT_DATE - 1, 5)`,
    [target.id]
  );

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const admin = await pool.query(
    `INSERT INTO admins (venue_id, login, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, 'venue_admin', false) RETURNING id`,
    [source.id, LOGIN, passwordHash]
  );
  const adminId = admin.rows[0].id;
  await pool.query("INSERT INTO admin_venues (admin_id, venue_id, role) VALUES ($1, $2, 'owner')", [adminId, source.id]);
  await pool.query("INSERT INTO admin_venues (admin_id, venue_id, role) VALUES ($1, $2, 'owner')", [adminId, target.id]);

  const ids = { adminId, venueIds: [source.id, target.id] };

  try {
    const client = makeClient();
    const csrfLogin = await csrfFrom(client, '/admin/login');
    const login = await client.request('POST', '/admin/login', { _csrf: csrfLogin, login: LOGIN, password: PASSWORD });
    if (login.status !== 302) {
      console.error('Не удалось войти — проверка невозможна.', login.status, login.text.slice(0, 300));
      await cleanup(ids);
      process.exit(1);
    }
    const csrf = await csrfFrom(client, '/admin');

    // --- раздел 4: сводный экран ---------------------------------------------------------------
    console.log('\nСводный экран:');
    const summary = await client.request('GET', '/admin/venues');
    report(summary.status === 200, 'GET /admin/venues отвечает 200', `статус ${summary.status}`);
    report(
      summary.text.includes(source.name) && summary.text.includes(target.name),
      'в таблице оба заведения'
    );
    report(summary.text.includes('>17<'), 'просмотры за 7 дней показаны', 'ожидали 17 у источника');
    report(
      /venues-summary-num is-warn">1</.test(summary.text.replace(/\s+/g, ' ')),
      'позиции в стоп-листе посчитаны и выделены'
    );
    report(summary.text.includes('venuesTotalViews'), 'график суммарных просмотров нарисован');
    report(summary.text.includes(`/menu/${source.slug}`), 'быстрая ссылка на меню заведения есть');
    report(
      summary.text.includes('/admin/venues') && summary.text.includes(`t('venues`) === false,
      'ключи словаря переведены, а не выведены как есть'
    );

    // Пункт меню появляется только у сети.
    report(summary.text.includes('href="/admin/venues"'), 'пункт «Все заведения» в боковом меню');

    // --- раздел 5: предпросмотр ---------------------------------------------------------------
    // Копируем В ЦЕЛЬ — значит она и должна быть активной: цель берётся из сессии, а не из формы.
    await client.request('POST', '/admin/switch-venue', { _csrf: csrf, venue_id: String(target.id) });

    console.log('\nПредпросмотр копирования:');
    const preview = await client.request('GET', `/admin/venues?source_venue_id=${source.id}&with_photos=1&with_prices=1`);
    report(preview.status === 200, 'предпросмотр отвечает 200', `статус ${preview.status}`);
    report(/категорий — 2/.test(preview.text) && /позиций — 3/.test(preview.text),
      'предпросмотр показал 2 категории и 3 позиции');
    report(preview.text.includes(target.name), 'предпросмотр называет заведение, куда копируем');
    // Список источников не должен предлагать заведение, в которое копируем.
    const selectBlock = /<select name="source_venue_id"[\s\S]*?<\/select>/.exec(preview.text);
    report(
      Boolean(selectBlock)
        && selectBlock[0].includes(`value="${source.id}"`)
        && !selectBlock[0].includes(`value="${target.id}"`),
      'активное заведение не предлагается как источник'
    );

    const previewSelf = await client.request('GET', `/admin/venues?source_venue_id=${target.id}`);
    report(
      previewSelf.status === 200 && previewSelf.text.includes('в него же') && !previewSelf.text.includes('Будет скопировано'),
      'предпросмотр копирования заведения в самого себя показывает ошибку вместо цифр'
    );

    // --- раздел 5: само копирование -----------------------------------------------------------
    console.log('\nКопирование:');
    const copy = await client.request('POST', '/admin/venues/copy', {
      _csrf: csrf, source_venue_id: String(source.id), with_photos: '1', with_prices: '1',
    });
    report(copy.status === 302, 'копирование отвечает редиректом (PRG)', `статус ${copy.status}`);
    report(
      Boolean(copy.location && copy.location.includes('copied_items=3')),
      'редирект сообщает о трёх скопированных позициях',
      String(copy.location)
    );

    const copied = await pool.query(
      `SELECT i.name_ru, i.price, i.old_price, i.is_available, i.photo_url, i.photo_thumb_url, c.name_ru AS category
       FROM items i JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $1 ORDER BY c.sort_order, i.sort_order`,
      [target.id]
    );
    report(copied.rows.length === 3, 'в целевом заведении три позиции', `нашли ${copied.rows.length}`);
    report(
      copied.rows.some((row) => row.name_ru === `БЛЮДО-С-ФОТО-${SUFFIX}` && Number(row.price) === 50000),
      'цены скопированы'
    );
    report(
      copied.rows.some((row) => row.name_ru === `БЛЮДО-В-СТОПЕ-${SUFFIX}` && row.is_available === false),
      'стоп-лист перенесён вместе с позицией'
    );

    const withPhoto = copied.rows.find((row) => row.photo_url);
    report(Boolean(withPhoto), 'у скопированной позиции есть фото');
    if (withPhoto) {
      report(
        withPhoto.photo_url.startsWith(`/uploads/${target.id}/`),
        'фото лежит в каталоге ЦЕЛЕВОГО заведения, а не переиспользовано по ссылке',
        withPhoto.photo_url
      );
      const onDisk = await fs.stat(path.join(UPLOADS_ROOT, withPhoto.photo_url.replace('/uploads/', '')))
        .then((s) => s.size).catch(() => 0);
      report(onDisk > 0, 'файл фото действительно существует на диске', `размер ${onDisk}`);

      // Промт: «удаление в одном не должно ломать другое». Удаляем оригинал — копия обязана жить.
      await fs.rm(path.join(UPLOADS_ROOT, photoUrl.replace('/uploads/', '')), { force: true });
      const stillThere = await fs.stat(path.join(UPLOADS_ROOT, withPhoto.photo_url.replace('/uploads/', '')))
        .then(() => true).catch(() => false);
      report(stillThere, 'удаление оригинала не сломало копию');
    }

    // Меню заведения изменилось целиком — гость обязан увидеть это сразу, а не через пять минут,
    // когда истечёт TTL кэша. Публичная страница запрашивается ТЕМ ЖЕ прогоном, без пауз:
    // если publishMenuChange из маршрута пропадёт, эта проверка упадёт первой.
    const publicMenu = await client.request('GET', `/menu/${target.slug}`);
    report(
      publicMenu.status === 200 && publicMenu.text.includes(`БЛЮДО-С-ФОТО-${SUFFIX}`),
      'скопированное меню сразу видно гостю (кэш сброшен)',
      `статус ${publicMenu.status}`
    );

    const copiedOptions = await pool.query(
      `SELECT o.name_ru, o.price_delta FROM item_options o
       JOIN item_option_groups g ON g.id = o.group_id
       JOIN items i ON i.id = g.item_id
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $1`,
      [target.id]
    );
    report(copiedOptions.rows.length === 1 && Number(copiedOptions.rows[0].price_delta) === 7000,
      'группы опций и варианты скопированы с надбавками',
      JSON.stringify(copiedOptions.rows));

    const logged = await pool.query(
      "SELECT details FROM admin_action_logs WHERE venue_id = $1 AND entity_type = 'menu_copy'",
      [target.id]
    );
    report(
      logged.rows.length === 1 && logged.rows[0].details.items === 3,
      'копирование записано в журнал действий',
      JSON.stringify(logged.rows.map((r) => r.details))
    );

    // --- обнуление цен -------------------------------------------------------------------------
    console.log('\nКопирование с обнулением цен:');
    const copyZero = await client.request('POST', '/admin/venues/copy', {
      _csrf: csrf, source_venue_id: String(source.id), with_photos: '0', with_prices: '0',
    });
    report(copyZero.status === 302, 'второе копирование прошло', `статус ${copyZero.status}`);

    const zeroed = await pool.query(
      `SELECT i.price, i.old_price, i.photo_url FROM items i
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $1 AND i.name_ru = $2 ORDER BY i.id DESC LIMIT 1`,
      [target.id, `БЛЮДО-С-ФОТО-${SUFFIX}`]
    );
    report(Number(zeroed.rows[0].price) === 0, 'цена обнулена', `цена ${zeroed.rows[0].price}`);
    report(zeroed.rows[0].old_price === null, 'старая (перечёркнутая) цена тоже убрана');
    report(zeroed.rows[0].photo_url === null, 'без фото — значит без фото');

    const zeroedOptions = await pool.query(
      `SELECT o.price_delta FROM item_options o
       JOIN item_option_groups g ON g.id = o.group_id
       JOIN items i ON i.id = g.item_id
       JOIN categories c ON c.id = i.category_id
       WHERE c.venue_id = $1 ORDER BY o.id DESC LIMIT 1`,
      [target.id]
    );
    report(Number(zeroedOptions.rows[0].price_delta) === 0, 'надбавка варианта обнулена вместе с ценой');

    // Копия дописалась ПОСЛЕ существующего меню, а не перемешалась с ним.
    const sortOrders = await pool.query(
      'SELECT sort_order FROM categories WHERE venue_id = $1 ORDER BY sort_order',
      [target.id]
    );
    report(
      new Set(sortOrders.rows.map((r) => r.sort_order)).size === sortOrders.rows.length,
      'порядок категорий не перемешался (sort_order не дублируются)',
      JSON.stringify(sortOrders.rows.map((r) => r.sort_order))
    );

    // --- отказы --------------------------------------------------------------------------------
    console.log('\nОтказы:');
    const foreign = await createVenue('foreign', 'ЧУЖОЕ');
    ids.venueIds.push(foreign.id);
    const denied = await client.request('POST', '/admin/venues/copy', {
      _csrf: csrf, source_venue_id: String(foreign.id), with_photos: '1', with_prices: '1',
    });
    report(
      denied.status === 302 && String(denied.location).includes('errorCopyNoAccess'),
      'копирование из заведения без доступа отклонено',
      `${denied.status} -> ${denied.location}`
    );
    const foreignItems = await pool.query(
      'SELECT count(*)::int AS count FROM categories WHERE venue_id = $1', [foreign.id]
    );
    report(foreignItems.rows[0].count === 0, 'чужое заведение при этом не тронуто');

    const same = await client.request('POST', '/admin/venues/copy', {
      _csrf: csrf, source_venue_id: String(target.id),
    });
    report(
      same.status === 302 && String(same.location).includes('errorCopySameVenue'),
      'копирование заведения в самого себя отклонено',
      `${same.status} -> ${same.location}`
    );

    // --- кому экран виден -----------------------------------------------------------------
    // Промт, раздел 3: manager — «всё, кроме подписки, оплаты и управления сотрудниками».
    // Проверяется и запрет (403), и то, что пункт меню на этот запрет не ведёт: ссылка,
    // гарантированно упирающаяся в отказ, — дефект, даже если сам запрет работает.
    console.log('\nВидимость по ролям:');
    const ownerPage = await client.request('GET', '/admin/venues');
    report(
      ownerPage.text.includes('href="/admin/subscription"') && ownerPage.text.includes('href="/admin/staff"'),
      'у владельца в меню есть подписка и сотрудники'
    );

    await pool.query("UPDATE admin_venues SET role = 'manager' WHERE admin_id = $1 AND venue_id = $2", [adminId, target.id]);
    const managerPage = await client.request('GET', '/admin/venues');
    report(managerPage.status === 200, 'управляющему сводный экран доступен', `статус ${managerPage.status}`);
    report(
      !managerPage.text.includes('href="/admin/subscription"') && !managerPage.text.includes('href="/admin/staff"'),
      'у управляющего в меню нет подписки и сотрудников'
    );
    report(
      managerPage.text.includes('href="/admin/venues"'),
      'пункт «Все заведения» управляющему остаётся'
    );
    const managerSubscription = await client.request('GET', '/admin/subscription');
    report(managerSubscription.status === 403, 'подписка управляющему закрыта', `статус ${managerSubscription.status}`);

    // staff: сводный экран не в белом списке middlewares/staffAccess.js, значит 403.
    await pool.query("UPDATE admin_venues SET role = 'staff' WHERE admin_id = $1 AND venue_id = $2", [adminId, target.id]);
    const staffPage = await client.request('GET', '/admin/venues');
    report(staffPage.status === 403, 'официанту сводный экран закрыт', `статус ${staffPage.status}`);
    const staffCopy = await client.request('POST', '/admin/venues/copy', {
      _csrf: csrf, source_venue_id: String(source.id),
    });
    report(staffCopy.status === 403, 'официант не может копировать меню', `статус ${staffCopy.status}`);

    // Одно заведение — экрана сети нет вовсе: и пункта в меню, и самого маршрута.
    await pool.query("UPDATE admin_venues SET role = 'owner' WHERE admin_id = $1 AND venue_id = $2", [adminId, target.id]);
    await pool.query('DELETE FROM admin_venues WHERE admin_id = $1 AND venue_id = $2', [adminId, source.id]);
    const singlePage = await client.request('GET', '/admin/venues');
    report(singlePage.status === 404, 'при одном заведении сводного экрана нет', `статус ${singlePage.status}`);
    const dashboard = await client.request('GET', '/admin');
    report(
      !dashboard.text.includes('href="/admin/venues"'),
      'при одном заведении нет и пункта меню'
    );
    report(
      !dashboard.text.includes('venue-switcher-panel'),
      'при одном заведении переключатель — просто название, без выпадающего списка'
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
