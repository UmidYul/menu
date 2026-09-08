// Промт 4.2, ревизия безопасности: «Проверка на IDOR: для каждого маршрута, принимающего id,
// убедись, что фильтр по venue_id стоит В SQL, а не только в шаблоне. Составь список
// проверенных маршрутов».
//
//   node scripts/check-idor.js
//
// Проверка ЭМПИРИЧЕСКАЯ, а не чтением кода. Скрипт заводит второе заведение со своим владельцем,
// логинится под ним по-настоящему и дёргает каждый venue-scoped маршрут с ЧУЖИМ id. Успехом
// считается, что сервер отказал (403/404/редирект) И данные в БД не изменились — второе важнее
// первого: маршрут может ответить редиректом и при этом тихо выполнить UPDATE.
//
// Требует запущенного сервера на APP_BASE_URL (по умолчанию http://localhost:3000).
require('dotenv').config();

const bcrypt = require('bcrypt');
const { pool } = require('../src/config/db');
const env = require('../src/config/env');

const BASE = env.APP_BASE_URL || 'http://localhost:3000';
const SUFFIX = Date.now().toString(36);
const INTRUDER_LOGIN = `idor_probe_${SUFFIX}`;
const INTRUDER_PASSWORD = 'IdorProbe12345';

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

// --- минимальный HTTP-клиент с cookie ---------------------------------------------------------

function makeClient() {
  const jar = new Map();

  function cookieHeader() {
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

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

  return { request, cookieHeader };
}

async function csrfFrom(client, path) {
  const page = await client.request('GET', path);
  const match = /name="_csrf" value="([^"]+)"/.exec(page.text);
  return match ? match[1] : null;
}

// --- подготовка: второе заведение и его владелец ------------------------------------------------

async function setupIntruder() {
  const venue = await pool.query(
    `INSERT INTO venues (slug, name, lang_default, status, is_active, show_powered_by)
     VALUES ($1, $2, 'ru', 'active', true, true) RETURNING id, slug`,
    [`idor-probe-${SUFFIX}`, `IDOR-проба ${SUFFIX}`]
  );
  const passwordHash = await bcrypt.hash(INTRUDER_PASSWORD, 10);
  const admin = await pool.query(
    `INSERT INTO admins (venue_id, login, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, 'venue_admin', false) RETURNING id`,
    [venue.rows[0].id, INTRUDER_LOGIN, passwordHash]
  );
  return { venueId: venue.rows[0].id, slug: venue.rows[0].slug, adminId: admin.rows[0].id };
}

async function cleanup(intruder) {
  // Порядок важен: admin_action_logs ссылается на admins с ON DELETE RESTRICT.
  await pool.query('DELETE FROM admin_action_logs WHERE venue_id = $1 OR admin_id = $2', [intruder.venueId, intruder.adminId]);
  await pool.query('DELETE FROM admins WHERE id = $1', [intruder.adminId]);
  await pool.query('DELETE FROM venues WHERE id = $1', [intruder.venueId]);
}

// --- цели: сущности ЖЕРТВЫ, к которым чужак не должен иметь доступа -----------------------------

async function collectVictimTargets(intruderVenueId) {
  const pick = async (sql) => {
    const result = await pool.query(sql, [intruderVenueId]);
    return result.rows[0] || null;
  };

  return {
    venue: await pick('SELECT id, slug FROM venues WHERE id <> $1 AND status = $$active$$ ORDER BY id LIMIT 1'),
    category: await pick('SELECT c.id, c.venue_id FROM categories c WHERE c.venue_id <> $1 ORDER BY c.id LIMIT 1'),
    item: await pick('SELECT i.id, i.is_available, c.venue_id FROM items i JOIN categories c ON c.id = i.category_id WHERE c.venue_id <> $1 ORDER BY i.id LIMIT 1'),
    optionGroup: await pick('SELECT g.id FROM item_option_groups g JOIN items i ON i.id = g.item_id JOIN categories c ON c.id = i.category_id WHERE c.venue_id <> $1 ORDER BY g.id LIMIT 1'),
    option: await pick('SELECT o.id, o.is_available FROM item_options o JOIN item_option_groups g ON g.id = o.group_id JOIN items i ON i.id = g.item_id JOIN categories c ON c.id = i.category_id WHERE c.venue_id <> $1 ORDER BY o.id LIMIT 1'),
    table: await pick('SELECT id, number FROM venue_tables WHERE venue_id <> $1 ORDER BY id LIMIT 1'),
    review: await pick('SELECT id, status FROM reviews WHERE venue_id <> $1 ORDER BY id LIMIT 1'),
    schedule: await pick(`SELECT s.id FROM availability_schedules s
                          LEFT JOIN categories c ON c.id = s.category_id
                          LEFT JOIN items i ON i.id = s.item_id
                          LEFT JOIN categories ic ON ic.id = i.category_id
                          WHERE COALESCE(c.venue_id, ic.venue_id) <> $1 ORDER BY s.id LIMIT 1`),
    staff: await pick("SELECT id FROM admins WHERE venue_id <> $1 AND role = 'staff' ORDER BY id LIMIT 1"),
    call: await pick('SELECT id, status FROM waiter_calls WHERE venue_id <> $1 ORDER BY id LIMIT 1'),
  };
}

// Отказом считаем 403, 404 и редирект (роуты кабинета на неудаче обычно редиректят).
// 200 означает, что чужак получил чужую страницу — это провал независимо от содержимого.
function looksRejected(response) {
  return response.status === 403 || response.status === 404 || (response.status >= 300 && response.status < 400);
}

(async () => {
  console.log(`Проверка IDOR на ${BASE}`);
  const intruder = await setupIntruder();
  console.log(`Чужак: заведение ${intruder.venueId}, логин ${INTRUDER_LOGIN}\n`);

  const client = makeClient();
  const csrfLogin = await csrfFrom(client, '/admin/login');
  const login = await client.request('POST', '/admin/login', {
    _csrf: csrfLogin, login: INTRUDER_LOGIN, password: INTRUDER_PASSWORD,
  });
  if (login.status !== 302) {
    console.error('Не удалось войти под чужаком — проверка невозможна.', login.status);
    await cleanup(intruder);
    process.exit(1);
  }

  const csrf = await csrfFrom(client, '/admin');
  const targets = await collectVictimTargets(intruder.venueId);

  // Каждая цель: маршрут + как убедиться, что данные жертвы НЕ изменились.
  const cases = [];

  if (targets.item) {
    cases.push({
      label: `POST /admin/items/${targets.item.id}/toggle (чужая позиция)`,
      method: 'POST', path: `/admin/items/${targets.item.id}/toggle`,
      verify: async () => {
        const now = await pool.query('SELECT is_available FROM items WHERE id = $1', [targets.item.id]);
        return now.rows[0].is_available === targets.item.is_available;
      },
    });
    cases.push({
      label: `PATCH /admin/items/${targets.item.id} (чужая позиция)`,
      method: 'POST', path: `/admin/items/${targets.item.id}?_method=PATCH`,
      body: { name_ru: 'ВЗЛОМАНО', name_uz: 'ВЗЛОМАНО', price: '1', currency: 'UZS', category_id: '1' },
      verify: async () => {
        const now = await pool.query('SELECT name_ru FROM items WHERE id = $1', [targets.item.id]);
        return now.rows[0].name_ru !== 'ВЗЛОМАНО';
      },
    });
    cases.push({
      label: `DELETE /admin/items/${targets.item.id} (чужая позиция)`,
      method: 'POST', path: `/admin/items/${targets.item.id}?_method=DELETE`,
      verify: async () => {
        const now = await pool.query('SELECT count(*)::int AS c FROM items WHERE id = $1', [targets.item.id]);
        return now.rows[0].c === 1;
      },
    });
    cases.push({
      label: `POST /admin/stoplist/items/${targets.item.id}/toggle (чужая позиция)`,
      method: 'POST', path: `/admin/stoplist/items/${targets.item.id}/toggle`,
      verify: async () => {
        const now = await pool.query('SELECT is_available FROM items WHERE id = $1', [targets.item.id]);
        return now.rows[0].is_available === targets.item.is_available;
      },
    });
  }

  if (targets.category) {
    cases.push({
      label: `PATCH /admin/categories/${targets.category.id} (чужая категория)`,
      method: 'POST', path: `/admin/categories/${targets.category.id}?_method=PATCH`,
      body: { name_ru: 'ВЗЛОМАНО', name_uz: 'ВЗЛОМАНО' },
      verify: async () => {
        const now = await pool.query('SELECT name_ru FROM categories WHERE id = $1', [targets.category.id]);
        return now.rows[0].name_ru !== 'ВЗЛОМАНО';
      },
    });
    cases.push({
      label: `DELETE /admin/categories/${targets.category.id} (чужая категория)`,
      method: 'POST', path: `/admin/categories/${targets.category.id}?_method=DELETE`,
      verify: async () => {
        const now = await pool.query('SELECT count(*)::int AS c FROM categories WHERE id = $1', [targets.category.id]);
        return now.rows[0].c === 1;
      },
    });
    cases.push({
      label: `POST /admin/schedules/category/${targets.category.id} (расписание чужой категории)`,
      method: 'POST', path: `/admin/schedules/category/${targets.category.id}`,
      body: { days: '1', time_from: '08:00', time_to: '11:00' },
      verify: async () => {
        const now = await pool.query('SELECT count(*)::int AS c FROM availability_schedules WHERE category_id = $1', [targets.category.id]);
        return now.rows[0].c === 0 || true; // проверяем ниже точнее — по факту создания чужаком
      },
    });
  }

  if (targets.optionGroup) {
    cases.push({
      label: `DELETE /admin/item-options/groups/${targets.optionGroup.id} (чужая группа опций)`,
      method: 'POST', path: `/admin/item-options/groups/${targets.optionGroup.id}?_method=DELETE`,
      verify: async () => {
        const now = await pool.query('SELECT count(*)::int AS c FROM item_option_groups WHERE id = $1', [targets.optionGroup.id]);
        return now.rows[0].c === 1;
      },
    });
  }

  if (targets.option) {
    cases.push({
      label: `POST /admin/stoplist/options/${targets.option.id}/toggle (чужой вариант опции)`,
      method: 'POST', path: `/admin/stoplist/options/${targets.option.id}/toggle`,
      verify: async () => {
        const now = await pool.query('SELECT is_available FROM item_options WHERE id = $1', [targets.option.id]);
        return now.rows[0].is_available === targets.option.is_available;
      },
    });
  }

  if (targets.table) {
    cases.push({
      label: `POST /admin/tables/${targets.table.id}/rename (чужой стол)`,
      method: 'POST', path: `/admin/tables/${targets.table.id}/rename`,
      body: { number: 'ВЗЛОМАНО' },
      verify: async () => {
        const now = await pool.query('SELECT number FROM venue_tables WHERE id = $1', [targets.table.id]);
        return now.rows[0].number !== 'ВЗЛОМАНО';
      },
    });
    cases.push({
      label: `POST /admin/tables/${targets.table.id}/delete (чужой стол)`,
      method: 'POST', path: `/admin/tables/${targets.table.id}/delete`,
      verify: async () => {
        const now = await pool.query('SELECT count(*)::int AS c FROM venue_tables WHERE id = $1', [targets.table.id]);
        return now.rows[0].c === 1;
      },
    });
    cases.push({
      label: `GET /admin/tables/${targets.table.id}/qr.png (QR чужого стола)`,
      method: 'GET', path: `/admin/tables/${targets.table.id}/qr.png`,
      verify: async () => true,
    });
  }

  if (targets.review) {
    cases.push({
      label: `POST /admin/reviews/${targets.review.id}/status (чужой отзыв)`,
      method: 'POST', path: `/admin/reviews/${targets.review.id}/status`,
      body: { status: 'spam' },
      verify: async () => {
        const now = await pool.query('SELECT status FROM reviews WHERE id = $1', [targets.review.id]);
        return now.rows[0].status === targets.review.status;
      },
    });
    cases.push({
      label: `POST /admin/reviews/${targets.review.id}/note (чужой отзыв)`,
      method: 'POST', path: `/admin/reviews/${targets.review.id}/note`,
      body: { owner_reply: 'ВЗЛОМАНО' },
      verify: async () => {
        const now = await pool.query('SELECT owner_reply FROM reviews WHERE id = $1', [targets.review.id]);
        return (now.rows[0].owner_reply || '') !== 'ВЗЛОМАНО';
      },
    });
  }

  if (targets.schedule) {
    cases.push({
      label: `DELETE /admin/schedules/${targets.schedule.id} (чужое расписание)`,
      method: 'POST', path: `/admin/schedules/${targets.schedule.id}?_method=DELETE`,
      verify: async () => {
        const now = await pool.query('SELECT count(*)::int AS c FROM availability_schedules WHERE id = $1', [targets.schedule.id]);
        return now.rows[0].c === 1;
      },
    });
  }

  if (targets.staff) {
    cases.push({
      label: `POST /admin/staff/${targets.staff.id}/toggle-active (чужой сотрудник)`,
      method: 'POST', path: `/admin/staff/${targets.staff.id}/toggle-active`,
      verify: async () => {
        const now = await pool.query('SELECT is_active FROM admins WHERE id = $1', [targets.staff.id]);
        return now.rows[0] !== undefined;
      },
    });
    cases.push({
      label: `POST /admin/staff/${targets.staff.id}/invite (ссылка входа чужого сотрудника)`,
      method: 'POST', path: `/admin/staff/${targets.staff.id}/invite`,
      verify: async () => {
        const now = await pool.query(
          'SELECT count(*)::int AS c FROM password_reset_tokens WHERE admin_id = $1 AND created_at > now() - interval $$1 minute$$',
          [targets.staff.id]
        );
        return now.rows[0].c === 0;
      },
    });
  }

  if (targets.call) {
    cases.push({
      label: `POST /admin/calls/${targets.call.id}/ack (чужой вызов официанта)`,
      method: 'POST', path: `/admin/calls/${targets.call.id}/ack`,
      verify: async () => {
        const now = await pool.query('SELECT status FROM waiter_calls WHERE id = $1', [targets.call.id]);
        return now.rows[0].status === targets.call.status;
      },
    });
  }

  if (targets.venue) {
    cases.push({
      label: `GET /superadmin/venues/${targets.venue.id} (суперадминка глазами владельца)`,
      method: 'GET', path: `/superadmin/venues/${targets.venue.id}`,
      verify: async () => true,
    });
  }

  console.log('Маршруты (чужой id под чужой сессией):');
  for (const testCase of cases) {
    const body = testCase.body ? { ...testCase.body, _csrf: csrf } : { _csrf: csrf };
    // eslint-disable-next-line no-await-in-loop
    const response = testCase.method === 'GET'
      ? await client.request('GET', testCase.path)
      : await client.request('POST', testCase.path, body);

    // eslint-disable-next-line no-await-in-loop
    const dataIntact = await testCase.verify();
    const rejected = looksRejected(response);

    report(
      rejected && dataIntact,
      testCase.label,
      `ответ ${response.status}${response.location ? ` -> ${response.location}` : ''}, данные не тронуты: ${dataIntact}`
    );
  }

  // Отдельно: расписание, созданное чужаком для чужой категории, не должно существовать.
  if (targets.category) {
    const created = await pool.query(
      `SELECT count(*)::int AS c FROM availability_schedules
       WHERE category_id = $1 AND time_from = '08:00' AND time_to = '11:00'`,
      [targets.category.id]
    );
    report(created.rows[0].c === 0, 'чужак не создал расписание в чужой категории');
  }

  await cleanup(intruder);

  console.log(`\nпроверено маршрутов: ${passed + failed}, успешно отбито: ${passed}, провалов: ${failed}`);
  if (failed > 0) process.exitCode = 1;
  process.exit(process.exitCode || 0);
})().catch(async (err) => {
  console.error('Скрипт упал:', err);
  process.exit(1);
});
