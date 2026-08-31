const TTL_MS = 5 * 60 * 1000; // 5 минут

const store = new Map();
const ogImageStore = new Map();

// Публичная страница меню теперь одна на (заведение, язык) — все категории рендерятся сразу,
// а :categoryId в URL влияет только на начальный скролл на клиенте, так что не является частью
// ключа кэша (иначе одна и та же HTML-страница кэшировалась бы под разными ключами зря).
function buildKey(slug, lang) {
  return `${slug}:${lang}`;
}

function get(slug, lang) {
  const key = buildKey(slug, lang);
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
function set(venueId, slug, lang, html) {
  store.set(buildKey(slug, lang), { html, venueId, expiresAt: Date.now() + TTL_MS });
}

// og:image теперь тоже разный по языку (подпись "ЦИФРОВОЕ МЕНЮ"/"DIGITAL MENU"/... рисуется
// на языке страницы) — ключ строится так же, как для HTML.
function getOgImage(slug, lang) {
  const key = buildKey(slug, lang);
  const entry = ogImageStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    ogImageStore.delete(key);
    return null;
  }
  return entry.buffer;
}

function setOgImage(venueId, slug, lang, buffer) {
  ogImageStore.set(buildKey(slug, lang), { buffer, venueId, expiresAt: Date.now() + TTL_MS });
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
}

// Полный сброс — используется при восстановлении LISTEN-соединения к Postgres: за время обрыва
// события menu_changed могли потеряться, так что нельзя доверять ничему, что уже в кэше.
function clear() {
  store.clear();
  ogImageStore.clear();
}

module.exports = { get, set, getOgImage, setOgImage, invalidate, clear };
