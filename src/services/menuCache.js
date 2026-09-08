const TTL_MS = 5 * 60 * 1000; // 5 минут

const store = new Map();

// Ключ для og:image — без хоста, см. комментарий у getOgImage ниже.
function ogKey(slug, lang) {
  return `${slug}:${lang}`;
}

const ogImageStore = new Map();
// Промт 2.5: манифест PWA кэшируется и инвалидируется вместе с меню. Он не зависит от языка
// (название заведения одно), поэтому ключ — только slug.
const manifestStore = new Map();

// Публичная страница меню теперь одна на (заведение, язык) — все категории рендерятся сразу,
// а :categoryId в URL влияет только на начальный скролл на клиенте, так что не является частью
// ключа кэша (иначе одна и та же HTML-страница кэшировалась бы под разными ключами зря).
//
// Промт 3.7 добавил в ключ ХОСТ. Одно и то же меню на своём домене и на адресе сервиса —
// это РАЗНЫЙ HTML: canonical, hreflang, og:url и ссылка на манифест указывают на тот адрес,
// по которому страницу открыли. Без хоста в ключе первый же гость, зашедший через qr.menu,
// закэшировал бы страницу с каноническим адресом сервиса, и её получали бы все, кто пришёл
// на menu.mykafe.uz, — то есть поисковик склеил бы домены ровно наоборот тому, что просит промт.
function buildKey(host, slug, lang) {
  return `${host}|${slug}:${lang}`;
}

function get(host, slug, lang) {
  const key = buildKey(host, slug, lang);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.html;
}

// venueId хранится в значении (а не только в ключе через slug), потому что инвалидация приходит
// по venue_id — из другого процесса (см. pgNotify.js) он единственное, что доступно, а slug к
// этому моменту мог смениться.
// maxAgeMs — потолок жизни записи, короче обычных 5 минут. Промт 2.3: доступность по расписанию
// считается на сервере при рендере, поэтому страница, где завтраки заканчиваются в 11:00, не
// имеет права дожить до 11:05. Вызывающий код (publicMenu.js) передаёт сюда время до ближайшей
// границы интервала; без расписаний аргумента нет и TTL остаётся прежним.
function set(venueId, host, slug, lang, html, maxAgeMs) {
  const ttl = typeof maxAgeMs === 'number' && maxAgeMs >= 0 ? Math.min(TTL_MS, maxAgeMs) : TTL_MS;
  store.set(buildKey(host, slug, lang), { html, venueId, expiresAt: Date.now() + ttl });
}

// og:image теперь тоже разный по языку (подпись "ЦИФРОВОЕ МЕНЮ"/"DIGITAL MENU"/... рисуется
// на языке страницы) — ключ строится так же, как для HTML.
// og:image и манифест PWA от хоста НЕ зависят: картинка рисует только название заведения,
// манифест — название, цвета и иконки. Поэтому у них по-прежнему ключ без хоста, и одна
// сгенерированная картинка обслуживает оба адреса.
function getOgImage(slug, lang) {
  const key = ogKey(slug, lang);
  const entry = ogImageStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    ogImageStore.delete(key);
    return null;
  }
  return entry.buffer;
}

function setOgImage(venueId, slug, lang, buffer) {
  ogImageStore.set(ogKey(slug, lang), { buffer, venueId, expiresAt: Date.now() + TTL_MS });
}

// Манифест ЗАВИСИТ от хоста, в отличие от og:image: на своём домене у установленного
// приложения start_url и scope — корень домена, а на адресе сервиса — /menu/<slug>.
// Общий ключ раздавал бы одно и то же приложение с чужой стартовой страницей.
function getManifest(host, slug) {
  const entry = manifestStore.get(`${host}|${slug}`);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    manifestStore.delete(`${host}|${slug}`);
    return null;
  }
  return entry.json;
}

function setManifest(venueId, host, slug, json) {
  manifestStore.set(`${host}|${slug}`, { json, venueId, expiresAt: Date.now() + TTL_MS });
}

// Сбрасывает закэшированные страницы меню этого заведения на всех языках, а также сгенерированную
// og:image-превьюшку — по venue_id, а не по slug, чтобы переименование заведения не оставляло
// "зависший" старый ключ. Вызывается и локально (сразу после сохранения в админке), и из
// pgNotify.js при событии от другого процесса — двойной вызов безвреден (Map.delete идемпотентен).
function invalidate(venueId) {
  if (!venueId) return;
  for (const [key, entry] of store) {
    if (entry.venueId === venueId) store.delete(key);
  }
  for (const [key, entry] of ogImageStore) {
    if (entry.venueId === venueId) ogImageStore.delete(key);
  }
  for (const [key, entry] of manifestStore) {
    if (entry.venueId === venueId) manifestStore.delete(key);
  }
}

// Полный сброс — используется при восстановлении LISTEN-соединения к Postgres: за время обрыва
// события menu_changed могли потеряться, так что нельзя доверять ничему, что уже в кэше.
function clear() {
  store.clear();
  ogImageStore.clear();
  manifestStore.clear();
}

module.exports = { get, set, getOgImage, setOgImage, getManifest, setManifest, invalidate, clear };
