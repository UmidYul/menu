// Промт 3.6: «КРИТИЧНО: каждый запрос к данным обязан фильтровать по activeVenueId В SQL.
// <...> Это главный риск задачи: ошибка здесь — утечка данных между заведениями».
//
//   node scripts/check-venue-isolation.js
//
// Проверка ЭМПИРИЧЕСКАЯ и сквозная. Скрипт заводит ОДИН аккаунт с ДВУМЯ заведениями, наполняет
// каждое своими данными (категория, позиция, стол, отзыв), логинится и, переключаясь между
// заведениями, проверяет, что на каждом экране видно только своё. Плюс третье, ЧУЖОЕ заведение,
// к которому доступа нет вовсе, — чтобы отличить «фильтр по активному» от «фильтра по всем моим».
//
// Читать код и убеждаться, что фильтр на месте, здесь недостаточно: сотня мест, и достаточно
// одного пропущенного, чтобы владелец увидел чужую выручку.
require('dotenv').config();

const bcrypt = require('bcrypt');
const { pool } = require('../src/config/db');
const env = require('../src/config/env');

const BASE = env.APP_BASE_URL || 'http://localhost:3000';
const SUFFIX = Date.now().toString(36);
const LOGIN = `iso_probe_${SUFFIX}`;
const PASSWORD = 'IsolationProbe123';

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

  async function request(method, path, body) {
    const headers = { Cookie: cookieHeader() };
    let payload;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    }
    const response = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
    storeCookies(response);
    const text = await response.text().catch(() => '');
    return { status: response.status, location: response.headers.get('location'), text };
  }

  return { request };
}

async function csrfFrom(client, path) {
  const page = await client.request('GET', path);
  const match = /name="_csrf" value="([^"]+)"/.exec(page.text);
  return match ? match[1] : null;
}

// --- подготовка ---------------------------------------------------------------------------------

async function createVenue(label) {
  const venue = await pool.query(
    `INSERT INTO venues (slug, name, lang_default, status, is_active, show_powered_by)
     VALUES ($1, $2, 'ru', 'active', true, true) RETURNING id, slug, name`,
    [`iso-${label}-${SUFFIX}`, `ИЗО-${label}-${SUFFIX}`]
  );
  const row = venue.rows[0];

  // Наполняем УНИКАЛЬНЫМИ строками: если они перепутаются на экране, это будет видно сразу.
  const category = await pool.query(
    `INSERT INTO categories (venue_id, name_ru, name_uz, sort_order)
     VALUES ($1, $2, $2, 1) RETURNING id`,
    [row.id, `КАТ-${label}-${SUFFIX}`]
  );
  const item = await pool.query(
    `INSERT INTO items (category_id, name_ru, name_uz, price, currency, sort_order)
     VALUES ($1, $2, $2, 12345, 'UZS', 1) RETURNING id`,
    [category.rows[0].id, `БЛЮДО-${label}-${SUFFIX}`]
  );
  const table = await pool.query(
    `INSERT INTO venue_tables (venue_id, number, token) VALUES ($1, $2, $3) RETURNING id`,
    [row.id, `СТОЛ-${label}`, `isotoken-${label}-${SUFFIX}`]
  );
  const review = await pool.query(
    `INSERT INTO reviews (venue_id, rating, comment, lang, session_hash)
     VALUES ($1, 5, $2, 'ru', $3) RETURNING id`,
    [row.id, `ОТЗЫВ-${label}-${SUFFIX}`, `isohash-${label}-${SUFFIX}`]
  );

  return {
    ...row,
    label,
    categoryId: category.rows[0].id,
    categoryName: `КАТ-${label}-${SUFFIX}`,
    itemId: item.rows[0].id,
    itemName: `БЛЮДО-${label}-${SUFFIX}`,
    tableId: table.rows[0].id,
    tableNumber: `СТОЛ-${label}`,
    reviewId: review.rows[0].id,
    reviewText: `ОТЗЫВ-${label}-${SUFFIX}`,
  };
}

async function cleanup(ids) {
  await pool.query('DELETE FROM admin_action_logs WHERE venue_id = ANY($1) OR admin_id = ANY($2)', [ids.venueIds, [ids.adminId]]);
  await pool.query('DELETE FROM reviews WHERE venue_id = ANY($1)', [ids.venueIds]);
  await pool.query('DELETE FROM venue_tables WHERE venue_id = ANY($1)', [ids.venueIds]);
  await pool.query('DELETE FROM items WHERE category_id IN (SELECT id FROM categories WHERE venue_id = ANY($1))', [ids.venueIds]);
  await pool.query('DELETE FROM categories WHERE venue_id = ANY($1)', [ids.venueIds]);
  await pool.query('DELETE FROM admin_venues WHERE venue_id = ANY($1) OR admin_id = $2', [ids.venueIds, ids.adminId]);
  await pool.query('DELETE FROM admins WHERE id = $1', [ids.adminId]);
  await pool.query('DELETE FROM venues WHERE id = ANY($1)', [ids.venueIds]);
}

(async () => {
  console.log(`Проверка изоляции заведений на ${BASE}`);

  const venueA = await createVenue('A');
  const venueB = await createVenue('B');
  const venueForeign = await createVenue('ЧУЖОЕ');

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const admin = await pool.query(
    `INSERT INTO admins (venue_id, login, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, 'venue_admin', false) RETURNING id`,
    [venueA.id, LOGIN, passwordHash]
  );
  const adminId = admin.rows[0].id;

  // Доступ ровно к двум заведениям из трёх. К третьему — нет вовсе.
  await pool.query("INSERT INTO admin_venues (admin_id, venue_id, role) VALUES ($1, $2, 'owner')", [adminId, venueA.id]);
  await pool.query("INSERT INTO admin_venues (admin_id, venue_id, role) VALUES ($1, $2, 'manager')", [adminId, venueB.id]);

  const ids = { adminId, venueIds: [venueA.id, venueB.id, venueForeign.id] };

  console.log(`Аккаунт ${LOGIN}: owner в ${venueA.id}, manager в ${venueB.id}; ${venueForeign.id} — чужое\n`);

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

    async function switchTo(venueId) {
      const response = await client.request('POST', '/admin/switch-venue', { _csrf: csrf, venue_id: String(venueId) });
      return response.status;
    }

    // Страницы, на которых видно данные конкретного заведения, и что на них искать.
    const pages = [
      { path: '/admin/categories', field: 'categoryName' },
      { path: '/admin/items', field: 'itemName' },
      { path: '/admin/tables', field: 'tableNumber' },
      { path: '/admin/reviews', field: 'reviewText' },
      { path: '/admin/stoplist', field: 'itemName' },
    ];

    for (const [active, other] of [[venueA, venueB], [venueB, venueA]]) {
      // eslint-disable-next-line no-await-in-loop
      await switchTo(active.id);
      console.log(`Активно «${active.name}» (${active.label}):`);

      for (const page of pages) {
        // eslint-disable-next-line no-await-in-loop
        const response = await client.request('GET', page.path);
        const own = response.text.includes(active[page.field]);
        const foreign = response.text.includes(other[page.field])
          || response.text.includes(venueForeign[page.field]);

        report(
          own && !foreign,
          `${page.path}: видно своё, не видно чужого`,
          `статус ${response.status}, своё=${own}, чужое=${foreign}`
        );
      }

      // Данные третьего заведения не должны появляться нигде и никогда.
      // eslint-disable-next-line no-await-in-loop
      const dashboard = await client.request('GET', '/admin');
      report(
        !dashboard.text.includes(venueForeign.name),
        `/admin: заведения без доступа нет на дашборде`
      );
    }

    // Прямое обращение к сущностям заведения, к которому доступа нет вовсе.
    console.log('\nЧужое заведение (доступа нет):');
    await switchTo(venueA.id);

    const foreignCases = [
      { label: 'переключиться на чужое заведение', method: 'POST', path: '/admin/switch-venue', body: { venue_id: String(venueForeign.id) } },
      { label: 'переключить позицию чужого заведения', method: 'POST', path: `/admin/items/${venueForeign.itemId}/toggle` },
      { label: 'править категорию чужого заведения', method: 'POST', path: `/admin/categories/${venueForeign.categoryId}?_method=PATCH`, body: { name_ru: 'ВЗЛОМ', name_uz: 'ВЗЛОМ' } },
      { label: 'переименовать стол чужого заведения', method: 'POST', path: `/admin/tables/${venueForeign.tableId}/rename`, body: { number: 'ВЗЛОМ' } },
      { label: 'пометить чужой отзыв спамом', method: 'POST', path: `/admin/reviews/${venueForeign.reviewId}/status`, body: { status: 'spam' } },
    ];

    for (const testCase of foreignCases) {
      // eslint-disable-next-line no-await-in-loop
      const response = await client.request(testCase.method, testCase.path, { ...(testCase.body || {}), _csrf: csrf });
      const rejected = response.status === 403 || response.status === 404
        || (response.status >= 300 && response.status < 400);
      report(rejected, testCase.label, `ответ ${response.status}${response.location ? ` -> ${response.location}` : ''}`);
    }

    // Данные чужого заведения не изменились ни в одном случае.
    const untouched = await pool.query(
      `SELECT
         (SELECT name_ru FROM categories WHERE id = $1) AS category,
         (SELECT number FROM venue_tables WHERE id = $2) AS table_number,
         (SELECT status FROM reviews WHERE id = $3) AS review_status`,
      [venueForeign.categoryId, venueForeign.tableId, venueForeign.reviewId]
    );
    const row = untouched.rows[0];
    report(
      row.category === venueForeign.categoryName && row.table_number === venueForeign.tableNumber && row.review_status === 'new',
      'данные чужого заведения в БД не изменились',
      JSON.stringify(row)
    );

    // Активное заведение после всех попыток осталось прежним: неудачное переключение не должно
    // молча оставлять сессию в неопределённом состоянии.
    const afterAttempts = await client.request('GET', '/admin/categories');
    report(
      afterAttempts.text.includes(venueA.categoryName) && !afterAttempts.text.includes(venueForeign.categoryName),
      'после отказов активным осталось разрешённое заведение'
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
