const venueDomainModel = require('../models/venueDomainModel');

// Промт 3.7, раздел 2: «Результат поиска кэшировать в памяти с инвалидацией через тот же NOTIFY».
//
// Кэш здесь устроен иначе, чем menuCache: не «запись на ключ с TTL», а ОДИН снимок всей
// таблицы активных доменов. Активных доменов на порядки меньше, чем страниц меню, они меняются
// раз в жизни домена, и просматривать их надо на КАЖДОМ входящем запросе — включая запросы
// на собственный хост сервиса. Кэш промахов при такой нагрузке был бы отдельным механизмом
// со своей инвалидацией; целиком перечитанная таблица проще и не может «протухнуть частично».
//
// Пока снимок не загружен, lookup() возвращает undefined, а не «домен не найден»: разница
// принципиальная — на неизвестном домене мы редиректим на сервис, и делать это только потому,
// что кэш ещё не прогрет, нельзя.

let byDomain = null;
let loadedAt = null;
let loadingPromise = null;
let lastError = null;

// Перезагрузка снимка. Одновременные вызовы разделяют один запрос к БД: на старте процесса
// первые запросы гостей приходят пачкой, и каждому делать свой SELECT незачем.
function reload() {
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const rows = await venueDomainModel.listActiveWithVenue();
      const next = new Map();
      for (const row of rows) {
        next.set(row.domain, {
          venueId: row.venue_id,
          slug: row.slug,
          domain: row.domain,
          isPrimary: row.is_primary,
        });
      }
      byDomain = next;
      loadedAt = new Date();
      lastError = null;
    } catch (err) {
      lastError = err.message;
      // Старый снимок НЕ сбрасывается: работать по чуть устаревшему списку доменов лучше,
      // чем перестать узнавать их все из-за одной неудачной перезагрузки.
      console.error('domainCache: не удалось загрузить список доменов —', err.message);
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

// undefined — снимок ещё не готов (вызывающий код обязан отличать это от «не наш домен»),
// null — домен в снимке отсутствует, объект — найден.
function lookup(domain) {
  if (byDomain === null) return undefined;
  return byDomain.get(domain) || null;
}

function isReady() {
  return byDomain !== null;
}

// Инвалидация — полная перезагрузка, а не точечное удаление ключа: событие приходит с venue_id
// (см. pgNotify.js), а у заведения доменов может быть два, и один из них мог только что
// смениться. Перечитать десяток строк дешевле, чем поддерживать точечную логику, которая
// однажды разойдётся с тем, что в таблице.
function invalidate() {
  return reload();
}

function getStatus() {
  return {
    ready: byDomain !== null,
    count: byDomain ? byDomain.size : 0,
    loadedAt: loadedAt ? loadedAt.toISOString() : null,
    lastError,
  };
}

// Только для проверок: сбрасывает состояние модуля, чтобы следующий lookup снова считался
// «кэш не прогрет».
function resetForTests() {
  byDomain = null;
  loadedAt = null;
  lastError = null;
}

module.exports = { reload, lookup, isReady, invalidate, getStatus, resetForTests };
