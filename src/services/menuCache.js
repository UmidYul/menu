const TTL_MS = 5 * 60 * 1000; // 5 минут

const store = new Map();

function buildKey(slug, lang, categoryId) {
  return `${slug}:${lang}:${categoryId}`;
}

function get(slug, lang, categoryId) {
  const key = buildKey(slug, lang, categoryId);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.html;
}

function set(slug, lang, categoryId, html) {
  store.set(buildKey(slug, lang, categoryId), { html, expiresAt: Date.now() + TTL_MS });
}

// Сбрасывает закэшированные страницы меню этого заведения на всех языках и категориях —
// вызывается при любом сохранении категорий/позиций/настроек этого venue в админке.
function invalidateVenue(slug) {
  if (!slug) return;
  const prefix = `${slug}:`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

module.exports = { get, set, invalidateVenue };
