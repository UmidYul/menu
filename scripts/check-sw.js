// Промт 2.5. Проверка логики service worker:
//   node scripts/check-sw.js
//
// Зачем отдельный скрипт: зарегистрировать воркер можно только в настоящем браузере, а самое
// вероятное место ошибки в нём — не «работает ли офлайн вообще», а РЕШЕНИЯ: какой запрос
// перехватывать, что класть в кэш, что вытеснять, какой кэш считать устаревшим. Это чистая
// логика, и её можно прогнать в Node на поддельном Cache API — без браузера, повторяемо
// и быстро. То, что проверить так нельзя (реальная установка, поведение iOS), в README
// отмечено как непроверенное.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

// --- поддельные Cache API / Response / fetch ---------------------------------------------------
// Ровно столько, сколько использует sw.js, и ни строкой больше: цель — прогнать его решения,
// а не написать второй браузер.

class FakeHeaders {
  constructor(init) { this.map = new Map(Object.entries(init || {}).map(([k, v]) => [k.toLowerCase(), String(v)])); }
  get(name) { return this.map.has(String(name).toLowerCase()) ? this.map.get(String(name).toLowerCase()) : null; }
}

class FakeResponse {
  constructor(body, init) {
    const options = init || {};
    this.body = body;
    this.status = options.status === undefined ? 200 : options.status;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new FakeHeaders(options.headers);
    this.url = options.url || '';
  }
  clone() { return new FakeResponse(this.body, { status: this.status, headers: Object.fromEntries(this.headers.map), url: this.url }); }
  async json() { return JSON.parse(this.body); }
  async blob() { return { size: Buffer.byteLength(String(this.body)) }; }
}

class FakeCache {
  constructor() { this.entries = new Map(); }
  // Порядок вставки = порядок ключей, как у настоящего Cache API. На нём держится LRU в sw.js.
  async put(request, response) {
    const url = typeof request === 'string' ? request : request.url;
    this.entries.delete(url);
    this.entries.set(url, response);
  }
  async match(request) {
    const url = typeof request === 'string' ? request : request.url;
    return this.entries.get(url) || null;
  }
  async keys() { return Array.from(this.entries.keys()).map((url) => ({ url })); }
  async delete(request) {
    const url = typeof request === 'string' ? request : request.url;
    return this.entries.delete(url);
  }
  async add() { /* офлайн-страницу в этих проверках не трогаем */ }
}

function makeEnvironment({ network }) {
  const stores = new Map();
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name);
    },
    async keys() { return Array.from(stores.keys()); },
    async delete(name) { return stores.delete(name); },
    async match(request, options) {
      const name = options && options.cacheName;
      if (name) {
        const cache = stores.get(name);
        return cache ? cache.match(request) : null;
      }
      for (const cache of stores.values()) {
        // eslint-disable-next-line no-await-in-loop
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      return null;
    },
  };

  const listeners = new Map();
  const self = {
    location: { origin: 'https://qr.menu' },
    addEventListener(type, handler) { listeners.set(type, handler); },
    skipWaiting() { self.skipWaitingCalled = true; },
    clients: { claim: async () => {} },
    registration: {},
  };

  const context = {
    self,
    caches,
    fetch: network,
    Response: FakeResponse,
    Request: class { constructor(url, init) { this.url = url; Object.assign(this, init); } },
    URL,
    setTimeout,
    clearTimeout,
    console,
    Promise,
    Map,
    Number,
    Boolean,
    String,
    JSON,
  };
  context.self.caches = caches;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'sw.js'), 'utf8'), context);

  return { context, self, caches, stores, listeners };
}

// Событие fetch: собираем то, что воркер решил ответить, — или null, если он не вмешался.
function fireFetch(env, request) {
  let responded = null;
  const handler = env.listeners.get('fetch');
  handler({ request, respondWith(promise) { responded = promise; } });
  return responded;
}

function req(url, init) {
  return Object.assign({ url, method: 'GET', mode: 'no-cors' }, init || {});
}

(async () => {
  console.log('Что воркер перехватывает, а что пропускает мимо:');
  {
    const env = makeEnvironment({ network: async () => new FakeResponse('ok') });
    check('POST не перехватывается никогда', () => assert.strictEqual(
      fireFetch(env, req('https://qr.menu/order/demo', { method: 'POST' })), null
    ));
    check('чужой origin не перехватывается', () => assert.strictEqual(
      fireFetch(env, req('https://evil.example/x.js')), null
    ));
    check('админка не перехватывается', () => assert.strictEqual(
      fireFetch(env, req('https://qr.menu/admin/items', { mode: 'navigate' })), null
    ));
    check('/api/events не перехватывается', () => assert.strictEqual(
      fireFetch(env, req('https://qr.menu/api/events/demo')), null
    ));
    // Манифест — обычный GET, но не навигация и не статика из /css|/js|/fonts|/icons,
    // поэтому воркер обязан пропустить его в сеть как есть.
    check('манифест не перехватывается', () => assert.strictEqual(
      fireFetch(env, req('https://qr.menu/menu/demo/manifest.webmanifest')), null
    ));
    check('HTML меню перехватывается', () => assert.notStrictEqual(
      fireFetch(env, req('https://qr.menu/menu/demo', { mode: 'navigate' })), null
    ));
    check('CSS перехватывается', () => assert.notStrictEqual(
      fireFetch(env, req('https://qr.menu/css/design-system.css')), null
    ));
    check('фото перехватывается', () => assert.notStrictEqual(
      fireFetch(env, req('https://qr.menu/uploads/9/a-thumb.webp')), null
    ));
  }

  console.log('\nHTML: network-first, кэш как запасной вариант');
  {
    let online = true;
    const env = makeEnvironment({
      network: async () => {
        if (!online) throw new Error('offline');
        return new FakeResponse('<html>свежее</html>');
      },
    });

    await checkAsync('при живой сети отдаётся сетевой ответ', async () => {
      const response = await fireFetch(env, req('https://qr.menu/menu/demo', { mode: 'navigate' }));
      assert.strictEqual(response.body, '<html>свежее</html>');
    });

    await checkAsync('ответ положен в кэш', async () => {
      const names = await env.caches.keys();
      assert.ok(names.some((n) => n.startsWith('qrmenu-html-demo-')), `кэшей нет: ${names.join(', ')}`);
    });

    online = false;
    await checkAsync('без сети отдаётся сохранённая копия', async () => {
      const response = await fireFetch(env, req('https://qr.menu/menu/demo', { mode: 'navigate' }));
      assert.strictEqual(response.body, '<html>свежее</html>');
    });

    await checkAsync('и страница помечена как показанная из кэша', async () => {
      const meta = await env.stores.get('qrmenu-meta').match('/__sw/stale');
      assert.deepStrictEqual(await meta.json(), { demo: true });
    });
  }

  console.log('\nЗаглушка приостановленного заведения не попадает в кэш меню');
  {
    const env = makeEnvironment({
      network: async () => new FakeResponse('<html>меню недоступно</html>', { headers: { 'x-menu-cacheable': '0' } }),
    });
    await checkAsync('ответ отдан гостю', async () => {
      const response = await fireFetch(env, req('https://qr.menu/menu/demo', { mode: 'navigate' }));
      assert.ok(response.body.includes('недоступно'));
    });
    await checkAsync('но в кэш не положен', async () => {
      const cache = env.stores.get('qrmenu-html-demo-v0');
      assert.ok(!cache || cache.entries.size === 0, 'заглушка осела в кэше меню');
    });
  }

  console.log('\nСмена menu_version сбрасывает старый HTML-кэш');
  {
    const env = makeEnvironment({ network: async () => new FakeResponse('<html>v1</html>') });
    const message = env.listeners.get('message');
    const waits = [];
    const fire = (data) => message({ data, waitUntil: (p) => waits.push(p), ports: [] });

    fire({ type: 'CONFIG', slug: 'demo', menuVersion: '1' });
    await Promise.all(waits.splice(0));
    await fireFetch(env, req('https://qr.menu/menu/demo', { mode: 'navigate' }));

    await checkAsync('кэш версии 1 создан', async () => {
      assert.ok((await env.caches.keys()).includes('qrmenu-html-demo-v1'));
    });

    fire({ type: 'CONFIG', slug: 'demo', menuVersion: '2' });
    await Promise.all(waits.splice(0));

    await checkAsync('после смены версии старый кэш удалён', async () => {
      assert.ok(!(await env.caches.keys()).includes('qrmenu-html-demo-v1'));
    });
  }

  console.log('\nФото: cache-first и вытеснение по LRU');
  {
    const env = makeEnvironment({
      // 1 МБ на файл — чтобы упереться в лимит 40 МБ на 41-м, не создавая 120 записей.
      network: async () => new FakeResponse('x', { headers: { 'content-length': String(1024 * 1024) } }),
    });

    for (let i = 1; i <= 45; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await fireFetch(env, req(`https://qr.menu/uploads/9/photo-${i}.webp`, {
        referrer: 'https://qr.menu/menu/demo',
      }));
    }

    await checkAsync('в кэше остаётся не больше 40 МБ', async () => {
      const cache = env.stores.get('qrmenu-photos-demo');
      assert.strictEqual(cache.entries.size, 40, `записей: ${cache.entries.size}`);
    });

    await checkAsync('вытеснены самые старые, свежие на месте', async () => {
      const cache = env.stores.get('qrmenu-photos-demo');
      const urls = Array.from(cache.entries.keys());
      assert.ok(!urls.some((u) => u.endsWith('photo-1.webp')), 'самое старое фото не вытеснено');
      assert.ok(urls.some((u) => u.endsWith('photo-45.webp')), 'самое свежее фото потеряно');
    });

    await checkAsync('повторный запрос идёт из кэша, а не в сеть', async () => {
      let networkCalls = 0;
      const env2 = makeEnvironment({
        network: async () => { networkCalls += 1; return new FakeResponse('img', { headers: { 'content-length': '10' } }); },
      });
      const url = 'https://qr.menu/uploads/9/one.webp';
      await fireFetch(env2, req(url, { referrer: 'https://qr.menu/menu/demo' }));
      await fireFetch(env2, req(url, { referrer: 'https://qr.menu/menu/demo' }));
      assert.strictEqual(networkCalls, 1, `запросов в сеть: ${networkCalls}`);
    });
  }

  console.log('\nОбновление воркера');
  {
    const env = makeEnvironment({ network: async () => new FakeResponse('ok') });
    check('install сам по себе НЕ вызывает skipWaiting (сначала уведомляем вкладки)', () => {
      env.listeners.get('install')({ waitUntil: () => {} });
      assert.notStrictEqual(env.self.skipWaitingCalled, true);
    });
    check('SKIP_WAITING от страницы срабатывает', () => {
      env.listeners.get('message')({ data: { type: 'SKIP_WAITING' }, waitUntil: () => {}, ports: [] });
      assert.strictEqual(env.self.skipWaitingCalled, true);
    });
  }

  console.log(`\nпроверок пройдено: ${passed}`);
  if (process.exitCode) console.error('есть падения — см. FAIL выше');
})();
