const { pool } = require('../config/db');
const venueTelegramLinkModel = require('../models/venueTelegramLinkModel');
const adminModel = require('../models/adminModel');
const venueModel = require('../models/venueModel');
const notificationModel = require('../models/notificationModel');
const { logAction } = require('../models/adminActionLogModel');

// Код одноразовый — claim() в модели уже атомарно гасит гонку/повторное использование.
// Возвращает { ok: false, reason: 'invalid_code' } | { ok: true, venueName }.
async function consumeLinkCode(rawCode, telegramId) {
  const claimed = await venueTelegramLinkModel.claim(rawCode);
  if (!claimed) {
    return { ok: false, reason: 'invalid_code' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Этот telegram_id уже привязан к ДРУГОМУ админу — перепривязка "перетирает" старую
    // (edge case промта 1.5): у прежнего владельца снимается и admins.telegram_id, и
    // owner_telegram_id его венью (иначе там осталась бы устаревшая денормализованная копия,
    // и напоминания по подписке того заведения продолжили бы уходить чужому Telegram-аккаунту),
    // и ему уходит уведомление об отвязке.
    const previousOwner = await adminModel.findByTelegramId(telegramId);
    if (previousOwner && previousOwner.id !== claimed.admin_id) {
      await adminModel.clearTelegramId(client, previousOwner.id);
      if (previousOwner.venue_id) {
        await client.query('UPDATE venues SET owner_telegram_id = NULL WHERE id = $1', [previousOwner.venue_id]);
      }
      if (previousOwner.email) {
        await notificationModel.enqueue(client, {
          channel: 'email',
          recipient: previousOwner.email,
          template: 'admin_telegram_unlinked',
          payload: { admin_login: previousOwner.login },
          lang: 'ru',
        });
      }
    }

    await adminModel.setTelegramId(client, claimed.admin_id, telegramId);
    await client.query('UPDATE venues SET owner_telegram_id = $2 WHERE id = $1', [claimed.venue_id, telegramId]);

    await logAction(client, {
      adminId: claimed.admin_id,
      venueId: claimed.venue_id,
      actionType: 'update',
      entityType: 'admin',
      entityId: claimed.admin_id,
      details: { action: 'telegram_linked' },
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const venue = await venueModel.findById(claimed.venue_id);
  return { ok: true, venueName: venue ? venue.name : '' };
}

async function unlink(adminId, venueId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await adminModel.clearTelegramId(client, adminId);
    await client.query('UPDATE venues SET owner_telegram_id = NULL WHERE id = $1', [venueId]);
    await logAction(client, {
      adminId, venueId, actionType: 'update', entityType: 'admin', entityId: adminId, details: { action: 'telegram_unlinked' },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { consumeLinkCode, unlink };
