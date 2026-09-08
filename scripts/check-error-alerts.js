// Промт 4.2. Проверка алертов о 500-х:
//   node scripts/check-error-alerts.js
//
// Дедупликация здесь — не удобство, а требование промта: «иначе при массовой ошибке владелец
// получит тысячу сообщений и заблокирует бота». Поэтому её и фильтр чувствительных ключей
// проверяем явно, а не полагаемся на то, что код выглядит правильным.
require('dotenv').config();

const assert = require('assert');
const errorAlerts = require('../src/services/errorAlerts');
const { pool } = require('../src/config/db');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

function fakeReq(overrides) {
  return Object.assign({
    method: 'POST',
    originalUrl: '/admin/items',
    path: '/admin/items',
    body: {},
    query: {},
    session: { admin: { venueId: 9, role: 'venue_admin' } },
  }, overrides || {});
}

(async () => {
  console.log('Фильтр чувствительных ключей:');
  {
    const dirty = {
      login: 'aziz',
      password: 'СуперСекрет123',
      _csrf: 'abcdef',
      new_password: 'ещё секрет',
      card_number: '8600123412341234',
      nested: { authorization: 'Bearer xyz', comment: 'обычный текст' },
      sessionData: { cookie: 'qrmenu.sid=...' },
      apiKey: 'k-123',
    };
    const clean = errorAlerts.sanitize(dirty);

    check('пароль скрыт', () => assert.strictEqual(clean.password, '[скрыто]'));
    check('_csrf скрыт', () => assert.strictEqual(clean._csrf, '[скрыто]'));
    check('new_password скрыт (совпадение по подстроке)', () => assert.strictEqual(clean.new_password, '[скрыто]'));
    check('номер карты скрыт', () => assert.strictEqual(clean.card_number, '[скрыто]'));
    check('вложенный authorization скрыт', () => assert.strictEqual(clean.nested.authorization, '[скрыто]'));
    check('sessionData скрыт целиком', () => assert.strictEqual(clean.sessionData, '[скрыто]'));
    check('apiKey скрыт', () => assert.strictEqual(clean.apiKey, '[скрыто]'));
    check('безобидные поля остались', () => assert.strictEqual(clean.login, 'aziz'));
    check('вложенный безобидный текст остался', () => assert.strictEqual(clean.nested.comment, 'обычный текст'));

    // Циклическая ссылка не должна ронять фильтр — в req.body такое приходит редко,
    // но в err.request и подобных объектах встречается regularly.
    const cyclic = { name: 'x' };
    cyclic.self = cyclic;
    check('циклическая ссылка не роняет фильтр', () => {
      const result = errorAlerts.sanitize(cyclic);
      assert.strictEqual(result.name, 'x');
    });

    check('длинная строка обрезается', () => {
      const long = errorAlerts.sanitize({ text: 'я'.repeat(500) });
      assert.ok(long.text.length < 260, `длина ${long.text.length}`);
    });
  }

  console.log('\nОтпечаток ошибки:');
  {
    const err1 = new Error('boom');
    const err2 = new Error('boom');
    const req = fakeReq();

    check('одна и та же ошибка с одного маршрута — один отпечаток', () => assert.strictEqual(
      errorAlerts.fingerprint(err1, req), errorAlerts.fingerprint(err1, req)
    ));
    check('та же строка ошибки из другого места кода — другой отпечаток', () => {
      // Стеки у err1 и err2 различаются номерами строк — именно поэтому склеивать ошибки
      // по тексту сообщения нельзя.
      assert.notStrictEqual(errorAlerts.fingerprint(err1, req), errorAlerts.fingerprint(err2, req));
    });
    check('та же ошибка с другого маршрута — другой отпечаток', () => assert.notStrictEqual(
      errorAlerts.fingerprint(err1, req),
      errorAlerts.fingerprint(err1, fakeReq({ originalUrl: '/admin/categories', path: '/admin/categories' }))
    ));
  }

  console.log('\nДедупликация (главное требование промта):');
  {
    errorAlerts._resetForTests();
    await pool.query("DELETE FROM notifications WHERE template = 'server_error'");

    const err = new Error('массовая ошибка');
    const req = fakeReq({ body: { password: 'secret', name: 'Плов' } });

    // 50 одинаковых ошибок подряд — ровно то, что бывает при массовом сбое.
    for (let i = 0; i < 50; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await errorAlerts.reportServerError(err, req);
    }

    const owners = (process.env.OWNER_TELEGRAM_ID || '').split(',').filter(Boolean).length;
    const result = await pool.query("SELECT count(*)::int AS count, payload FROM notifications WHERE template = 'server_error' GROUP BY payload");

    await checkAsync('50 одинаковых ошибок дали не больше одного алерта на владельца', async () => {
      const total = result.rows.reduce((sum, row) => sum + row.count, 0);
      assert.ok(total <= Math.max(owners, 1), `алертов в очереди: ${total}, владельцев: ${owners}`);
    });

    await checkAsync('в payload алерта нет пароля', async () => {
      if (result.rows.length === 0) return; // владельцев не задано — очередь пуста, это норма
      const payload = result.rows[0].payload;
      assert.strictEqual(payload.body.password, '[скрыто]');
      assert.strictEqual(payload.body.name, 'Плов');
    });

    await checkAsync('в payload есть маршрут и id заведения', async () => {
      if (result.rows.length === 0) return;
      const payload = result.rows[0].payload;
      assert.strictEqual(payload.route, 'POST /admin/items');
      assert.strictEqual(payload.venue_id, 9);
    });

    // Секрет, переданный ПАРАМЕТРОМ АДРЕСА, не должен попасть в алерт: фильтр чистит разобранный
    // req.query, а originalUrl несёт сырую строку целиком. Поймано сквозной проверкой на живой
    // 500-ке — до неё пароль уезжал в поле route.
    errorAlerts._resetForTests();
    await pool.query("DELETE FROM notifications WHERE template = 'server_error'");
    await errorAlerts.reportServerError(new Error('утечка в адресе'), fakeReq({
      method: 'GET',
      originalUrl: '/admin/items?password=secret123&order=42',
      path: '/admin/items',
      query: { password: 'secret123', order: '42' },
    }));
    const leak = await pool.query("SELECT payload FROM notifications WHERE template = 'server_error' LIMIT 1");

    await checkAsync('секрет из query-строки не попал в поле route', async () => {
      if (leak.rows.length === 0) return;
      const payload = leak.rows[0].payload;
      assert.ok(!payload.route.includes('secret123'), `route: ${payload.route}`);
      assert.strictEqual(payload.route, 'GET /admin/items');
      assert.strictEqual(payload.query.password, '[скрыто]');
      assert.strictEqual(payload.query.order, '42');
    });

    // Разные ошибки должны алертить независимо друг от друга — иначе дедупликация превратится
    // в «первая ошибка заглушила все остальные».
    await pool.query("DELETE FROM notifications WHERE template = 'server_error'");
    errorAlerts._resetForTests();
    await errorAlerts.reportServerError(new Error('первая'), req);
    await errorAlerts.reportServerError(new Error('вторая'), req);
    const second = await pool.query("SELECT count(*)::int AS count FROM notifications WHERE template = 'server_error'");

    await checkAsync('две РАЗНЫЕ ошибки дают два алерта', async () => {
      if (owners === 0) return;
      assert.strictEqual(second.rows[0].count, 2 * owners, `алертов: ${second.rows[0].count}`);
    });

    await pool.query("DELETE FROM notifications WHERE template = 'server_error'");
  }

  console.log('\nШаблон сообщения:');
  {
    const { renderNotification } = require('../bot/templates/notifications');
    const content = await renderNotification('telegram', 'server_error', {
      route: 'POST /admin/items',
      venue_id: 9,
      repeats: 137,
      stack: 'Error: boom\n    at handler (/app/src/routes/adminItems.js:12:3)',
    }, 'ru');

    check('в сообщении есть маршрут', () => assert.ok(content.text.includes('/admin/items')));
    check('в сообщении есть счётчик повторов', () => assert.ok(content.text.includes('137')));
    check('стек обёрнут в моноширинный блок', () => assert.ok(content.text.includes('```')));
  }

  console.log(`\nпроверок пройдено: ${passed}`);
  if (process.exitCode) console.error('есть падения — см. FAIL выше');
  process.exit(process.exitCode || 0);
})();
