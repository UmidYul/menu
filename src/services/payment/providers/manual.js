const { pool } = require('../../../config/db');
const venueModel = require('../../../models/venueModel');
const paymentModel = require('../../../models/paymentModel');
const paymentClaimModel = require('../../../models/paymentClaimModel');
const venueLifecycle = require('../../venueLifecycle');
const notificationModel = require('../../../models/notificationModel');
const { logAction } = require('../../../models/adminActionLogModel');
const siteSettingsCache = require('../../siteSettingsCache');
const { calculatePeriodPrice } = require('../../../config/constants');
const {
  todayUTC, parseDateOnly, formatDateOnly, addMonthsUTC, diffDaysUTC,
} = require('../../../utils/dateOnly');

// Реализация 'manual' — деньги приходят переводом на карту вручную, подтверждает человек
// (кнопка в Telegram или /superadmin/payment-claims). createInvoice/confirmPayment — тот же
// интерфейс, который встанет под будущий click.js/payme.js (см. src/services/payment/index.js):
// createInvoice(venueId, months) → { months, amount, currency, details } — details произвольной
// формы для отображения (для manual — реквизиты карты; для click/payme обычно ссылка/QR на оплату).
// confirmPayment(claimId, actor) → { alreadyProcessed: true } | { venue, payment, claim } —
// actor: { adminId } | null (null — действие от бота/автоматики, без вошедшего в сессию админа).

async function createInvoice(venueId, months) {
  const amount = calculatePeriodPrice(months);
  const siteSettings = await siteSettingsCache.get();
  return {
    months,
    amount,
    currency: 'UZS',
    details: {
      cardNumber: siteSettings.payment_card_number || null,
      cardHolder: siteSettings.payment_card_holder || null,
      bankName: siteSettings.payment_bank_name || null,
      instructions: {
        ru: siteSettings.payment_instructions_ru || null,
        uz: siteSettings.payment_instructions_uz || null,
        en: siteSettings.payment_instructions_en || null,
      },
    },
  };
}

async function confirmPayment(claimId, actor) {
  const adminId = actor && actor.adminId ? actor.adminId : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE — берём монопольную блокировку на строку заявки сразу, до любой другой работы:
    // конкурентная попытка (повторное нажатие кнопки, гонка с отменой заявкой) ждёт эту
    // транзакцию и после неё уже видит финальный статус, а не 'pending' по старому чтению.
    const claimResult = await client.query('SELECT * FROM payment_claims WHERE id = $1 FOR UPDATE', [claimId]);
    const claim = claimResult.rows[0];
    if (!claim || claim.status !== 'pending') {
      await client.query('ROLLBACK');
      return { alreadyProcessed: true };
    }

    const venueResult = await client.query('SELECT * FROM venues WHERE id = $1 FOR UPDATE', [claim.venue_id]);
    const venue = venueResult.rows[0];

    const today = todayUTC();
    const currentUntil = venue.subscription_until ? parseDateOnly(venue.subscription_until) : null;
    // От максимума текущей даты окончания и сегодня — досрочная оплата не сжигает уже
    // оплаченные дни; заведению в suspended (дата в прошлом) отсчёт всегда идёт от сегодня.
    const base = currentUntil && diffDaysUTC(currentUntil, today) > 0 ? currentUntil : today;
    const extendsUntilStr = formatDateOnly(addMonthsUTC(base, claim.months));
    const todayStr = formatDateOnly(today);

    const payment = await paymentModel.create(client, {
      venueId: venue.id,
      amount: claim.amount,
      currency: claim.currency,
      method: 'card',
      comment: claim.payer_note,
      paidAt: todayStr,
      extendsUntil: extendsUntilStr,
      createdBy: adminId,
    });

    await venueModel.updateSubscriptionUntil(client, venue.id, extendsUntilStr);
    // reviveToActiveIfNeeded возвращает venue как есть (без изменений), если переход не нужен —
    // например, заведение уже было active. subscription_until в этом случае в возврате будет
    // ещё старым (апдейт на строке выше произошёл раньше, но объект venue в памяти не обновился),
    // поэтому ниже он всё равно берётся из extendsUntilStr, а не из revivedVenue.
    const revivedVenue = await venueLifecycle.reviveToActiveIfNeeded(client, venue, { actorAdminId: adminId, reason: 'payment_claim' });

    const updatedClaim = await paymentClaimModel.markApproved(client, claimId, { reviewedBy: adminId, paymentId: payment.id });

    await logAction(client, {
      adminId,
      venueId: venue.id,
      actionType: 'create',
      entityType: 'payment',
      entityId: payment.id,
      details: {
        amount: payment.amount, currency: payment.currency, months: claim.months,
        extends_until: extendsUntilStr, via: 'payment_claim',
      },
    });

    if (venue.email) {
      await notificationModel.enqueue(client, {
        channel: 'email',
        recipient: venue.email,
        template: 'payment_recorded',
        payload: {
          venue_name: venue.name, amount: payment.amount, currency: payment.currency, extends_until: extendsUntilStr,
        },
        lang: venue.lang_default || 'ru',
      });
    }

    await client.query('COMMIT');
    return { venue: { ...revivedVenue, subscription_until: extendsUntilStr }, payment, claim: updatedClaim };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createInvoice, confirmPayment };
