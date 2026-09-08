const express = require('express');

const router = express.Router();
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const venueTableModel = require('../models/venueTableModel');
const orderModel = require('../models/orderModel');
const waiterCallModel = require('../models/waiterCallModel');
const notificationModel = require('../models/notificationModel');
const orderPricing = require('../services/orderPricing');
const { sessionHashFromRequest } = require('../services/eventTracking');
const { isOpenNow } = require('../utils/workingHours');
const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const { orderSubmitSchema, waiterCallSchema } = require('../validators/orderValidators');

const TABLE_COOKIE_PREFIX = 'mt_';
const HOUR_MS = 60 * 60 * 1000;
const MAX_ORDERS_PER_SESSION_HOUR = 3;
const MAX_WAITER_CALLS_PER_SESSION_HOUR = 10;
const WAITER_CALL_COOLDOWN_MS = 2 * 60 * 1000;

function guestLang(req, venue) {
  const cookieLang = req.cookies && req.cookies.menu_lang;
  if (SUPPORTED_LANGS.includes(cookieLang)) return cookieLang;
  return venue.lang_default || DEFAULT_LANG;
}

// Заведение + текущий стол гостя. Стол берётся ТОЛЬКО из httpOnly-cookie, выставленной при
// сканировании QR (см. resolveTable в publicMenu.js) — клиент не может назначить себе стол
// сам, иначе кто угодно слал бы заказы «со стола 7» мимо QR.
async function loadContext(req) {
  const venue = await venueModel.findPublicBySlug(req.params.slug);
  if (!venue) return { venue: null, table: null };

  const cookieValue = req.cookies && req.cookies[`${TABLE_COOKIE_PREFIX}${venue.slug}`];
  const tableId = Number(cookieValue);
  const table = Number.isInteger(tableId) && tableId > 0
    ? await venueTableModel.findActiveByIdForVenue(tableId, venue.id)
    : null;

  return { venue, table };
}

function ordersAvailable(venue) {
  return Boolean(venue.orders_enabled && venue.telegram_chat_id && !venue.telegram_chat_broken);
}

// Состояние для экрана заказа. Отдельным запросом, а не в HTML меню: страница кэшируется по
// slug+lang, и номер стола из неё раздавался бы всем гостям заведения (см. комментарий в
// publicMenu.js). Ответ намеренно без кэша.
router.get('/:slug/context', async (req, res, next) => {
  try {
    const { venue, table } = await loadContext(req);
    if (!venue) return res.status(404).json({ error: 'not_found' });

    res.set('Cache-Control', 'no-store');
    return res.json({
      ordersAvailable: ordersAvailable(venue),
      isOpen: isOpenNow(venue.working_hours),
      tableId: table ? table.id : null,
      tableNumber: table ? table.number : null,
      minOrderAmount: venue.min_order_amount === null || venue.min_order_amount === undefined
        ? null : Number(venue.min_order_amount),
      currency: null,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:slug', async (req, res, next) => {
  try {
    const { venue, table } = await loadContext(req);
    if (!venue) return res.status(404).json({ error: 'not_found' });

    const lang = guestLang(req, venue);
    const tt = (key, params) => t(key, lang, params);

    if (!ordersAvailable(venue)) {
      return res.status(409).json({ error: 'orders_disabled', message: tt('orders.errorOrdersDisabled') });
    }
    // Промт 2.4: «Заказ невозможен вне часов работы заведения — проверять на сервере».
    if (!isOpenNow(venue.working_hours)) {
      return res.status(409).json({ error: 'venue_closed', message: tt('orders.errorVenueClosed') });
    }

    const parsed = orderSubmitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'bad_request' });

    const sessionHash = sessionHashFromRequest(req);
    const recentOrders = await orderModel.countRecentBySessionHash(sessionHash, HOUR_MS);
    if (recentOrders >= MAX_ORDERS_PER_SESSION_HOUR) {
      return res.status(429).json({ error: 'too_many_orders', message: tt('orders.errorTooManyOrders') });
    }

    // Пересчёт по актуальному меню — цены и доступность берутся из БД, не из тела запроса.
    const priced = await orderPricing.recomputeOrder(venue, lang, parsed.data.items);
    if (!priced.ok) {
      // Промт 2.3: «блюдо кончилось» и «блюдо сейчас не по расписанию» — разные новости для
      // гостя. Общее «меню изменилось» на завтраке в час дня выглядит как поломка сайта.
      const outOfSchedule = priced.problems.some((problem) => problem.type === 'item_out_of_schedule');
      return res.status(409).json({
        error: 'cart_changed',
        message: outOfSchedule ? tt('schedules.errorCartOutOfSchedule') : tt('orders.errorCartChanged'),
        problems: priced.problems,
        total: priced.total,
      });
    }
    // Сумма разошлась с той, что видел гость (цену изменили, пока корзина висела открытой) —
    // тоже не отправляем молча: гость должен увидеть новую сумму и подтвердить заново.
    if (Math.round(priced.total) !== Math.round(parsed.data.expectedTotal)) {
      return res.status(409).json({
        error: 'total_changed',
        message: tt('orders.errorTotalChanged'),
        total: priced.total,
      });
    }

    const minAmount = venue.min_order_amount === null || venue.min_order_amount === undefined
      ? null : Number(venue.min_order_amount);
    if (minAmount !== null && priced.total < minAmount) {
      return res.status(409).json({
        error: 'below_min',
        message: tt('orders.errorBelowMin', { amount: minAmount.toLocaleString('ru-RU'), currency: priced.currency }),
      });
    }

    // Стол: из QR (cookie) либо введённый руками. Промт: заказ с несуществующим/деактивированным
    // токеном обрабатывается как заказ без стола с просьбой ввести номер — это уже произошло на
    // уровне loadContext (table === null), здесь остаётся принять введённое гостем значение.
    const tableNumber = table ? table.number : parsed.data.tableNumber;
    if (!tableNumber) {
      return res.status(400).json({ error: 'table_required', message: tt('orders.errorTableRequired') });
    }

    const order = await orderModel.create(venue, {
      tableId: table ? table.id : null,
      tableNumber,
      total: priced.total,
      currency: priced.currency,
      comment: parsed.data.comment,
      guestLang: lang,
      sessionHash,
      lines: priced.lines,
    });

    // Сообщение в группу уходит через общий аутбокс: живого Telegraf-инстанса в веб-процессе
    // нет (бот — отдельный процесс). Воркер бота отправит его и запишет message_id обратно в
    // orders, чтобы кнопки «Принят»/«Готово» могли редактировать ЭТО ЖЕ сообщение.
    await notificationModel.enqueue(pool, {
      channel: 'telegram',
      recipient: String(venue.telegram_chat_id),
      template: 'order_created',
      payload: {
        order_id: order.id,
        venue_id: venue.id,
        table_number: tableNumber,
        total: priced.total,
        currency: priced.currency,
        comment: parsed.data.comment,
        lines: priced.lines.map((line) => ({
          name: line.name, qty: line.qty, lineTotal: line.lineTotal,
          options: line.options.map((option) => option.name),
        })),
      },
      lang: venue.lang_default || DEFAULT_LANG,
      dedupKey: `order_created:${order.id}`,
    });

    return res.status(201).json({
      ok: true,
      orderId: order.id,
      statusToken: order.public_token,
      total: priced.total,
      currency: priced.currency,
      tableNumber,
    });
  } catch (err) {
    return next(err);
  }
});

// Экран «заказ отправлен» опрашивает статус (промт 2.4: раз в 10 секунд 15 минут). Токен
// случайный, а не последовательный id — иначе перебором можно было бы смотреть чужие заказы.
router.get('/:slug/:token/status', async (req, res, next) => {
  try {
    const order = await orderModel.findByPublicToken(req.params.token);
    if (!order) return res.status(404).json({ error: 'not_found' });

    // Промт 2.4, edge case: бота удалили из группы в момент отправки — заказ сохранён, но до
    // персонала не доехал. Отправка асинхронная (аутбокс), поэтому гость узнаёт об этом здесь,
    // на экране статуса: delivered=false, и клиент показывает «покажите заказ официанту».
    // Признак «не доехал» — связь помечена разорванной И у заказа так и не появился
    // message_id (успешно отправленный заказ его получает, см. worker/notifications.js).
    const venue = await venueModel.findById(order.venue_id);
    const delivered = Boolean(order.telegram_message_id)
      || !(venue && venue.telegram_chat_broken);

    res.set('Cache-Control', 'no-store');
    return res.json({ status: order.status, orderId: order.id, delivered });
  } catch (err) {
    return next(err);
  }
});

router.post('/:slug/waiter-call', async (req, res, next) => {
  try {
    const { venue, table } = await loadContext(req);
    if (!venue) return res.status(404).json({ error: 'not_found' });

    const lang = guestLang(req, venue);
    const tt = (key, params) => t(key, lang, params);

    if (!ordersAvailable(venue)) {
      return res.status(409).json({ error: 'orders_disabled', message: tt('orders.errorOrdersDisabled') });
    }
    // Вызов официанта возможен только с известного стола: иначе непонятно, к кому идти.
    if (!table) {
      return res.status(409).json({ error: 'table_required', message: tt('orders.errorWaiterNeedsTable') });
    }

    const parsed = waiterCallSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'bad_request' });

    const sessionHash = sessionHashFromRequest(req);
    const recentCalls = await waiterCallModel.countRecentBySessionHash(sessionHash, HOUR_MS);
    if (recentCalls >= MAX_WAITER_CALLS_PER_SESSION_HOUR) {
      return res.status(429).json({ error: 'too_many_calls', message: tt('orders.errorTooManyCalls') });
    }

    // Кулдаун на стол (промт: один вызов со стола в 2 минуты). Проверяется в БД, а не в памяти
    // процесса — переживает рестарт и одинаково работает для двух гостей за одним столом.
    const recentForTable = await waiterCallModel.findRecentForTable(table.id, WAITER_CALL_COOLDOWN_MS);
    if (recentForTable) {
      return res.status(429).json({ error: 'cooldown', message: tt('orders.waiterAlreadyCalled') });
    }

    const call = await waiterCallModel.create({
      venueId: venue.id,
      tableId: table.id,
      tableNumber: table.number,
      callType: parsed.data.callType,
      sessionHash,
      guestLang: lang,
    });

    await notificationModel.enqueue(pool, {
      channel: 'telegram',
      recipient: String(venue.telegram_chat_id),
      template: 'waiter_call_created',
      payload: {
        call_id: call.id,
        venue_id: venue.id,
        table_number: table.number,
        call_type: parsed.data.callType,
      },
      lang: venue.lang_default || DEFAULT_LANG,
      dedupKey: `waiter_call:${call.id}`,
    });

    return res.status(201).json({ ok: true, message: tt('orders.waiterCalled') });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
