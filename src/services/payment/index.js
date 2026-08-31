const { pool } = require('../../config/db');
const paymentClaimModel = require('../../models/paymentClaimModel');
const notificationModel = require('../../models/notificationModel');
const { logAction } = require('../../models/adminActionLogModel');
const siteSettingsCache = require('../siteSettingsCache');
const manualProvider = require('./providers/manual');

// Провайдер выбирается по site_settings.payment_provider — сейчас единственное значение
// 'manual'. Подключить Click/Payme — добавить providers/click.js с тем же интерфейсом
// (createInvoice/confirmPayment, см. комментарий в providers/manual.js) и зарегистрировать
// здесь; ни вызывающий код (роуты, бот), ни остальной этот файл трогать не нужно.
const PROVIDERS = { manual: manualProvider };

async function getProvider() {
  const siteSettings = await siteSettingsCache.get();
  return PROVIDERS[siteSettings.payment_provider] || manualProvider;
}

async function createInvoice(venueId, months) {
  const provider = await getProvider();
  return provider.createInvoice(venueId, months);
}

async function confirmPayment(claimId, actor) {
  const provider = await getProvider();
  return provider.confirmPayment(claimId, actor);
}

// Отклонение заявки — не часть провайдерского интерфейса (у автоматических провайдеров нет
// понятия "заявка на ручную проверку": оплата либо прошла через них, либо нет). Общая для
// кнопки в Telegram и /superadmin/payment-claims логика живёт здесь.
async function rejectClaim(claimId, actor, reason) {
  const adminId = actor && actor.adminId ? actor.adminId : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claimResult = await client.query('SELECT * FROM payment_claims WHERE id = $1 FOR UPDATE', [claimId]);
    const claim = claimResult.rows[0];
    if (!claim || claim.status !== 'pending') {
      await client.query('ROLLBACK');
      return { alreadyProcessed: true };
    }

    const venueResult = await client.query('SELECT name, email, lang_default FROM venues WHERE id = $1', [claim.venue_id]);
    const venue = venueResult.rows[0];

    const updatedClaim = await paymentClaimModel.markRejected(client, claimId, { reviewedBy: adminId, reason });

    await logAction(client, {
      adminId,
      venueId: claim.venue_id,
      actionType: 'update',
      entityType: 'payment',
      entityId: claim.id,
      details: { status: 'rejected', reject_reason: reason },
    });

    if (venue && venue.email) {
      await notificationModel.enqueue(client, {
        channel: 'email',
        recipient: venue.email,
        template: 'payment_claim_rejected',
        payload: { venue_name: venue.name, reason },
        lang: venue.lang_default || 'ru',
      });
    }

    await client.query('COMMIT');
    return { claim: updatedClaim };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Отмена — только сам venue_admin, только пока pending. Простой атомарный UPDATE (см.
// paymentClaimModel.markCancelled) — отдельной транзакции не нужно, тут нечего согласовывать
// с другими таблицами.
async function cancelClaim(claimId, venueId) {
  const claim = await paymentClaimModel.markCancelled(claimId, venueId);
  return claim ? { claim } : { alreadyProcessed: true };
}

module.exports = { createInvoice, confirmPayment, rejectClaim, cancelClaim };
