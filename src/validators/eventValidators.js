const { z } = require('zod');

// Промт 3.2. page_view пишется сервером (src/routes/publicMenu.js), а не клиентом — иначе
// блокировщики рекламы/трекеров срежут именно самую важную метрику. Поэтому его нет в списке
// типов, которые принимает /api/events: если клиент всё же попробует его прислать, событие
// молча отбрасывается как неизвестный тип — так же, как опечатка или устаревший тип со старой
// версии клиентского JS.
const CLIENT_EVENT_TYPES = [
  'category_click', 'item_view', 'item_add', 'item_remove',
  'search', 'search_empty', 'cart_open', 'order_sent', 'waiter_call',
  'wifi_copy', 'share', 'review_prompt', 'review_submit', 'lang_switch',
];

const MAX_EVENTS_PER_REQUEST = 100;
const MAX_QUERY_LENGTH = 200;

// JSON из fetch/sendBeacon приходит уже настоящими типами (не строками формы), поэтому схема
// проще, чем у обычных form-валидаторов проекта — coercion тут не нужна.
const eventSchema = z.object({
  event_type: z.enum(CLIENT_EVENT_TYPES),
  item_id: z.number().int().positive().nullable().optional(),
  category_id: z.number().int().positive().nullable().optional(),
  table_id: z.number().int().positive().nullable().optional(),
  query: z.string().trim().max(MAX_QUERY_LENGTH).nullable().optional(),
  value: z.number().finite().nullable().optional(),
  lang: z.enum(['ru', 'uz', 'en']).nullable().optional(),
  device: z.enum(['mobile', 'tablet', 'desktop']).nullable().optional(),
});

// Верхний уровень тела запроса — просто "это вообще похоже на пачку событий?". Содержимое
// каждого элемента проверяется отдельно (src/services/eventTracking.js) через safeParse по
// eventSchema поштучно — единственная невалидная запись не должна ронять всю пачку валидных.
const batchShapeSchema = z.object({
  events: z.array(z.unknown()).max(MAX_EVENTS_PER_REQUEST),
});

module.exports = { eventSchema, batchShapeSchema, CLIENT_EVENT_TYPES, MAX_EVENTS_PER_REQUEST, MAX_QUERY_LENGTH };
