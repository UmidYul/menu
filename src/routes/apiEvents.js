const express = require('express');

const router = express.Router();
const venueModel = require('../models/venueModel');
const menuEventModel = require('../models/menuEventModel');
const { batchShapeSchema } = require('../validators/eventValidators');
const { sessionHashFromRequest, buildEventRow, filterValidEvents } = require('../services/eventTracking');

const SUPPORTED_LANGS = ['ru', 'uz', 'en'];
// Тот же cookie, что LANG_COOKIE в src/routes/publicMenu.js — эвенты почти всегда несут lang
// сами (клиент знает язык отрендеренной страницы), это только резерв для событий без lang.
// Значение из cookie не доверенное как есть — не входящее в SUPPORTED_LANGS ушло бы в БД
// и упало на CHECK-ограничении menu_events_lang_check, поэтому фильтруем здесь же.
function fallbackLangFromCookie(req) {
  const cookieLang = req.cookies && req.cookies.menu_lang;
  return SUPPORTED_LANGS.includes(cookieLang) ? cookieLang : null;
}

// Промт 3.2. Заведение — в URL, не в теле: если бы venueId просто присылал клиент, любой мог бы
// приписать события чужому заведению, подменив число в JSON. slug в пути — тот же trust boundary,
// что и у самой страницы меню (кто угодно может закинуть событий на ЧУЖОЙ /menu/:slug ровно так
// же, как накрутить его view-счётчик простым скриптом, дёргающим страницу — это существующий,
// а не новый риск, session/IP-лимитеры ниже его не устраняют, а только ограничивают масштаб).
//
// Без CSRF (как и весь /menu) — гость анонимен, session-токена, к которому его привязывать, нет,
// а sendBeacon с телом Blob('application/json') физически не может добавить кастомный заголовок.
router.post('/:slug', async (req, res) => {
  const venue = await venueModel.findBySlug(req.params.slug);
  // Несуществующий slug — тихо 204, без 404: этот эндпоинт не должен становиться способом
  // проверить, какие slug'и существуют в системе (тот же принцип, что и у /admin/forgot).
  if (!venue) return res.status(204).end();

  const shape = batchShapeSchema.safeParse(req.body);
  if (!shape.success) return res.status(204).end();

  const validEvents = filterValidEvents(shape.data.events);
  if (validEvents.length === 0) return res.status(204).end();

  const hash = sessionHashFromRequest(req);
  const lang = fallbackLangFromCookie(req);
  const rows = validEvents.map((event) => buildEventRow(venue.id, hash, event, lang));

  // Не блокируем ответ на INSERT — гость (и sendBeacon) не должен ждать запись в БД, а ошибка
  // вставки не должна превращаться в статус-код, который клиент всё равно не читает.
  res.status(204).end();
  menuEventModel.insertBatch(rows).catch((err) => {
    console.error('apiEvents: не удалось записать пачку событий', err);
  });
});

module.exports = router;
