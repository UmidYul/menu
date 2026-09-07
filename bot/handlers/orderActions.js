const { Markup } = require('telegraf');
const { t } = require('../../src/i18n');
const orderModel = require('../../src/models/orderModel');
const waiterCallModel = require('../../src/models/waiterCallModel');
const venueModel = require('../../src/models/venueModel');

// Промт 2.4: «Нажатие обновляет статус и САМО сообщение (edit, а не новое сообщение), подписывая,
// кто принял». Отдельной проверки «кто именно нажал» нет и не нужно: кнопка живёт только на
// сообщении внутри привязанной группы заведения, значит нажать её может лишь тот, кто в этой
// группе состоит, — то есть персонал. Дополнительно сверяем, что чат нажатия действительно
// принадлежит заведению этого заказа: защита от подделанного callback_data со стороны.
async function assertChatOwnsVenue(ctx, venueId) {
  const venue = await venueModel.findById(venueId);
  if (!venue) return false;
  return String(venue.telegram_chat_id) === String(ctx.chat.id);
}

function whoLine(ctx, lang, key) {
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
    || ctx.from.username
    || String(ctx.from.id);
  return t(key, lang, { name });
}

// Текст сообщения переписывается целиком: берём исходный (Telegram отдаёт его в
// ctx.callbackQuery.message.text) и дописываем строку статуса — так не приходится заново
// собирать состав заказа из БД, и сообщение остаётся ровно тем, что видел персонал.
function appendStatusLine(ctx, statusLine) {
  const original = (ctx.callbackQuery.message && ctx.callbackQuery.message.text) || '';
  return `${original}\n\n${statusLine}`;
}

function register(bot) {
  bot.action(/^order:accept:(\d+)$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    const lang = ctx.state.lang;

    const order = await orderModel.findById(orderId);
    if (!order || !(await assertChatOwnsVenue(ctx, order.venue_id))) {
      return ctx.answerCbQuery(t('bot.orders.notFound', lang), { show_alert: true });
    }

    const updated = await orderModel.markAccepted(orderId, ctx.from.id);
    if (!updated) {
      // Кто-то уже нажал раньше — сообщение не переписываем повторно, просто отвечаем.
      return ctx.answerCbQuery(t('bot.orders.alreadyHandled', lang), { show_alert: true });
    }

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      appendStatusLine(ctx, whoLine(ctx, lang, 'bot.orders.acceptedBy')),
      // После «Принят» остаётся только «Готово» — повторно принимать нечего.
      Markup.inlineKeyboard([[Markup.button.callback(t('bot.orders.btnDone', lang), `order:done:${orderId}`)]])
    );
    return undefined;
  });

  bot.action(/^order:done:(\d+)$/, async (ctx) => {
    const orderId = Number(ctx.match[1]);
    const lang = ctx.state.lang;

    const order = await orderModel.findById(orderId);
    if (!order || !(await assertChatOwnsVenue(ctx, order.venue_id))) {
      return ctx.answerCbQuery(t('bot.orders.notFound', lang), { show_alert: true });
    }

    const updated = await orderModel.markDone(orderId, ctx.from.id);
    if (!updated) {
      return ctx.answerCbQuery(t('bot.orders.alreadyHandled', lang), { show_alert: true });
    }

    await ctx.answerCbQuery();
    // Заказ закрыт — кнопок больше нет (передаём пустую клавиатуру, а не оставляем старую).
    await ctx.editMessageText(
      appendStatusLine(ctx, whoLine(ctx, lang, 'bot.orders.doneBy')),
      Markup.inlineKeyboard([])
    );
    return undefined;
  });

  bot.action(/^waiter:ack:(\d+)$/, async (ctx) => {
    const callId = Number(ctx.match[1]);
    const lang = ctx.state.lang;

    const call = await waiterCallModel.findById(callId);
    if (!call || !(await assertChatOwnsVenue(ctx, call.venue_id))) {
      return ctx.answerCbQuery(t('bot.orders.notFound', lang), { show_alert: true });
    }

    const updated = await waiterCallModel.markAcknowledged(callId, ctx.from.id);
    if (!updated) {
      return ctx.answerCbQuery(t('bot.orders.alreadyHandled', lang), { show_alert: true });
    }

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      appendStatusLine(ctx, whoLine(ctx, lang, 'bot.orders.onMyWayBy')),
      Markup.inlineKeyboard([])
    );
    return undefined;
  });
}

module.exports = { register };
