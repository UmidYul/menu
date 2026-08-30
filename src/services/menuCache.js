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

function set(slug, lang, html) {
  store.set(buildKey(slug, lang), { html, expiresAt: Date.now() + TTL_MS });
}

function getOgImage(slug) {
  const entry = ogImageStore.get(slug);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    ogImageStore.delete(slug);
    return null;
  }
  return entry.buffer;
}

function setOgImage(slug, buffer) {
  ogImageStore.set(slug, { buffer, expiresAt: Date.now() + TTL_MS });
}

// Сбрасывает закэшированные страницы меню этого заведения на всех языках, а также
// сгенерированную og:image-превьюшку — вызывается при любом сохранении категорий/позиций/
// настроек этого venue в админке (название меняется — превью тоже должно).
function invalidateVenue(slug) {
  if (!slug) return;
  const prefix = `${slug}:`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
  ogImageStore.delete(slug);
}

module.exports = { get, set, getOgImage, setOgImage, invalidateVenue };
