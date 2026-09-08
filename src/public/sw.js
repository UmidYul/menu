/* eslint-disable no-restricted-globals */
// Промт 2.5. Service worker публичного меню.
//
// Область действия — весь origin (файл лежит в корне), но вмешивается воркер ТОЛЬКО в /menu/*,
// статику и загруженные фото. Всё остальное — админка, /api, /order, /review — идёт мимо него
// нетронутым: кэшировать POST-формы кабинета или заказы нельзя ни при каких обстоятельствах.

// Версия статического кэша. Меняется вручную вместе с правками sw.js и клиентских файлов —
// это «версия воркера», в отличие от menu_version, которая приходит со страницы и версионирует
// только HTML конкретного заведения.
const SW_VERSION = 'v1';

const STATIC_CACHE = `qrmenu-static-${SW_VERSION}`;
const OFFLINE_CACHE = `qrmenu-offline-${SW_VERSION}`;
const OFFLINE_URL = '/offline.html';

// Промт: HTML — network-first с таймаутом 3 секунды.
const HTML_TIMEOUT_MS = 3000;

// Промт: не больше 120 изображений и не больше 40 МБ на заведение, вытеснение по LRU.
const PHOTO_LIMIT_COUNT = 120;
const PHOTO_LIMIT_BYTES = 40 * 1024 * 1024;

// Заголовок, которым сервер помечает страницы, которые кэшировать нельзя: заглушка
// приостановленного/выключенного заведения и 404. Иначе гость, поставивший приложение, увидел бы
// закэшированную заглушку вместо вернувшегося меню — или, наоборот, старое меню вместо заглушки.
const NO_CACHE_HEADER = 'x-menu-cacheable';

// slug -> menu_version. Приходит со страницы через postMessage при каждой загрузке.
// Хранится в памяти воркера и переживает его сон плохо — поэтому дублируется в кэш META ниже.
const versions = new Map();
const META_CACHE = 'qrmenu-meta';
const META_VERSIONS_URL = '/__sw/versions';
const META_STALE_URL = '/__sw/stale';

function htmlCacheName(slug, version) {
  return `qrmenu-html-${slug}-v${version}`;
}

function photoCacheName(slug) {
  return `qrmenu-photos-${slug}`;
}

// --- служебное состояние в Cache API ----------------------------------------------------------
// Обычных переменных мало: браузер усыпляет воркер между событиями, и Map обнуляется. Кладём
// то, что должно пережить сон, в отдельный кэш как обычные Response.

async function readMeta(url, fallback) {
  try {
    const cache = await caches.open(META_CACHE);
    const response = await cache.match(url);
    if (!response) return fallback;
    return await response.json();
  } catch (err) {
    return fallback;
  }
}

async function writeMeta(url, value) {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(url, new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch (err) {
    /* приватный режим или переполненное хранилище — воркер просто работает без памяти */
  }
}

async function rememberVersion(slug, version) {
  versions.set(slug, version);
  const stored = await readMeta(META_VERSIONS_URL, {});
  if (stored[slug] === version) return;
  stored[slug] = version;
  await writeMeta(META_VERSIONS_URL, stored);
}

async function versionFor(slug) {
  if (versions.has(slug)) return versions.get(slug);
  const stored = await readMeta(META_VERSIONS_URL, {});
  if (stored[slug]) {
    versions.set(slug, stored[slug]);
    return stored[slug];
  }
  return null;
}

// Отметка «последняя навигация была отдана из кэша». Своих заголовков страница о себе прочитать
// не может, а navigator.onLine врёт (телефон в сети без интернета — самый обычный случай в зале).
// Поэтому воркер сам сообщает странице, что она смотрит на сохранённую копию.
async function markStale(slug, value) {
  const stored = await readMeta(META_STALE_URL, {});
  if (value) stored[slug] = true;
  else delete stored[slug];
  await writeMeta(META_STALE_URL, stored);
}

// --- разбор запросов ---------------------------------------------------------------------------

function slugFromPath(pathname) {
  const match = /^\/menu\/([^/?#]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function isStaticAsset(url) {
  return /^\/(css|js|fonts|icons)\//.test(url.pathname) || url.pathname === '/favicon.svg';
}

function isPhoto(url) {
  return url.pathname.startsWith('/uploads/');
}

function isMenuHtml(request, url) {
  return request.mode === 'navigate' && /^\/menu\/[^/]+/.test(url.pathname);
}

// --- стратегии ----------------------------------------------------------------------------------

// HTML: network-first с таймаутом. Гонка «сеть против таймера», а не просто fetch с ожиданием:
// зависший на 30 секунд запрос для гостя ничем не лучше отсутствия сети.
async function networkFirstHtml(request, slug) {
  const version = (await versionFor(slug)) || '0';
  const cacheName = htmlCacheName(slug, version);

  let networkResponse = null;
  try {
    networkResponse = await Promise.race([
      fetch(request),
      new Promise((resolve) => { setTimeout(() => resolve(null), HTML_TIMEOUT_MS); }),
    ]);
  } catch (err) {
    networkResponse = null;
  }

  if (networkResponse && networkResponse.ok) {
    // Заглушку «меню недоступно» и 404 не кэшируем — сервер помечает их заголовком.
    if (networkResponse.headers.get(NO_CACHE_HEADER) !== '0') {
      const copy = networkResponse.clone();
      caches.open(cacheName).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    await markStale(slug, false);
    return networkResponse;
  }

  const cached = await caches.match(request, { cacheName });
  if (cached) {
    await markStale(slug, true);
    return cached;
  }

  // Ни сети, ни копии — аккуратная страница «нет соединения», а не браузерная ошибка.
  const offline = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
  return offline || new Response('', { status: 504 });
}

// Статика: cache-first с фоновой ревалидацией. Отдаём мгновенно, а свежую версию подтягиваем
// молча — так первый экран не ждёт сети, но и не застревает на старом CSS навсегда.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const response = await network;
  return response || new Response('', { status: 504 });
}

// Фото: cache-first с потолком. Считаем размер через Cache API, как требует промт, — но не
// на каждый запрос, а только когда в кэш реально что-то добавили.
async function cacheFirstPhoto(request, slug) {
  const cacheName = photoCacheName(slug);
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // LRU: перекладываем запись в конец, переписывая её. Cache API отдаёт ключи в порядке
    // добавления, другого способа отметить «недавно использованное» у него нет.
    cache.put(request, cached.clone()).catch(() => {});
    return cached;
  }

  let response = null;
  try {
    response = await fetch(request);
  } catch (err) {
    return new Response('', { status: 504 });
  }

  if (response && response.ok) {
    await cache.put(request, response.clone());
    await enforcePhotoLimits(cacheName);
  }
  return response;
}

// Вытеснение по LRU: пока записей больше лимита или суммарный размер больше лимита — удаляем
// самую старую (первую в списке ключей). Размер берём из Content-Length, а где его нет —
// из фактического тела: для webp-превью это дешевле, чем кажется, и вызывается редко.
async function enforcePhotoLimits(cacheName) {
  try {
    const cache = await caches.open(cacheName);
    let keys = await cache.keys();

    let total = 0;
    const sizes = new Map();
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      const response = await cache.match(key);
      if (!response) continue;
      const declared = Number(response.headers.get('content-length'));
      let size = Number.isFinite(declared) && declared > 0 ? declared : 0;
      if (!size) {
        // eslint-disable-next-line no-await-in-loop
        const blob = await response.clone().blob();
        size = blob.size;
      }
      sizes.set(key.url, size);
      total += size;
    }

    while (keys.length > 0 && (keys.length > PHOTO_LIMIT_COUNT || total > PHOTO_LIMIT_BYTES)) {
      const oldest = keys.shift();
      total -= sizes.get(oldest.url) || 0;
      // eslint-disable-next-line no-await-in-loop
      await cache.delete(oldest);
    }
  } catch (err) {
    /* переполнение хранилища не должно ломать отдачу фото */
  }
}

// --- жизненный цикл -----------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  // Единственное, что кладём заранее, — офлайн-страница: без неё нечего показать в самый
  // важный момент. Всё остальное попадает в кэш по мере реального использования.
  event.waitUntil(
    caches.open(OFFLINE_CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .catch(() => {})
  );
  // skipWaiting здесь НЕ вызывается: промт требует сначала уведомить открытые вкладки.
  // Страница увидит registration.waiting, покажет полосу «меню обновилось» и пришлёт
  // SKIP_WAITING по нажатию — см. src/public/js/pwa.js.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(async (name) => {
      // Чужие версии статики и офлайн-страницы сносим. HTML- и фото-кэши заведений трогать
      // нельзя: они версионируются своим menu_version, а не версией воркера.
      const isOurStatic = name.startsWith('qrmenu-static-') || name.startsWith('qrmenu-offline-');
      if (isOurStatic && name !== STATIC_CACHE && name !== OFFLINE_CACHE) await caches.delete(name);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CONFIG' && data.slug) {
    // Версия меню приходит со страницы, а не из URL регистрации: разные заведения в одном
    // браузере делят одну область действия, и смена URL скрипта перерегистрировала бы воркер
    // туда-сюда на каждом переходе между меню.
    event.waitUntil((async () => {
      const previous = await versionFor(data.slug);
      await rememberVersion(data.slug, String(data.menuVersion));
      if (previous && previous !== String(data.menuVersion)) {
        // Меню заведения изменилось — старый HTML-кэш больше не нужен.
        await caches.delete(htmlCacheName(data.slug, previous));
      }
    })());
    return;
  }

  if (data.type === 'GET_STATE' && data.slug && event.ports && event.ports[0]) {
    const port = event.ports[0];
    event.waitUntil((async () => {
      const stale = await readMeta(META_STALE_URL, {});
      port.postMessage({ staleHtml: Boolean(stale[data.slug]) });
    })());
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Промт: никаких попыток кэшировать POST-запросы, корзину или заказы.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isMenuHtml(request, url)) {
    const slug = slugFromPath(url.pathname);
    if (slug) event.respondWith(networkFirstHtml(request, slug));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (isPhoto(url)) {
    // Фото кэшируются в разрезе заведения — лимиты в промте заданы «на заведение».
    // Реферер даёт slug страницы, с которой запрошено изображение; без него в общий кэш.
    let slug = null;
    try {
      slug = request.referrer ? slugFromPath(new URL(request.referrer).pathname) : null;
    } catch (err) {
      slug = null;
    }
    event.respondWith(cacheFirstPhoto(request, slug || 'shared'));
  }

  // Всё остальное (админка, /api/events, /order, /review, манифест) — сеть как есть.
});
