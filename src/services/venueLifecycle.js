const venueStatusHistoryModel = require('../models/venueStatusHistoryModel');
const notificationModel = require('../models/notificationModel');
const categoryModel = require('../models/categoryModel');
const env = require('../config/env');
const {
  todayUTC, parseDateOnly, formatDateOnly, addDaysUTC, truncateToDateUTC, diffDaysUTC,
} = require('../utils/dateOnly');

const MIN_CATEGORIES_TO_PUBLISH = 1;
const MIN_ITEMS_TO_PUBLISH = 3;

// Чеклист готовности к публикации — та же выборка, что уже строит список категорий с числом
// позиций в /admin/categories (listByVenueWithCounts), лишнего запроса не требует.
async function checkPublishReadiness(venue) {
  const categories = await categoryModel.listByVenueWithCounts(venue.id);
  const itemCount = categories.reduce((sum, c) => sum + c.item_count, 0);

  const missing = [];
  if (categories.length < MIN_CATEGORIES_TO_PUBLISH) missing.push('category');
  if (itemCount < MIN_ITEMS_TO_PUBLISH) missing.push('items');
  if (!venue.name) missing.push('name');
  if (!venue.phone) missing.push('phone');

  return { ready: missing.length === 0, missing, categoryCount: categories.length, itemCount };
}

const TRIAL_DAYS = 30;
const GRACE_DAYS = 5;
const ARCHIVE_AFTER_SUSPENDED_DAYS = 90;

// Единственная точка входа для изменения venues.status — гарантирует, что status_changed_at
// и venue_status_history никогда не разойдутся с самим статусом. toStatus === текущему —
// не переход, история не пишется (иначе продление подписки внутри уже активного периода
// заводило бы бессмысленные записи на каждый час пересчёта).
async function transitionStatus(client, venue, { toStatus, reason, actorAdminId, extra = {} }) {
  const fromStatus = venue.status;
  if (fromStatus === toStatus) return venue;

  const setClauses = ['status = $1', 'status_changed_at = now()'];
  const values = [toStatus];
  let i = 2;
  for (const [column, value] of Object.entries(extra)) {
    setClauses.push(`${column} = $${i}`);
    values.push(value);
    i += 1;
  }
  values.push(venue.id);

  const result = await client.query(
    `UPDATE venues SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  const updated = result.rows[0];

  await venueStatusHistoryModel.record(client, {
    venueId: venue.id, fromStatus, toStatus, reason, actorAdminId,
  });

  return updated;
}

// draft -> trial. Триал даётся один раз: trial_started_at не трогаем, если он уже проставлен
// (защита на случай повторного вызова — публикация доступна только из draft, так что в норме
// это невозможно, но лучше не молчать, а явно не перезаписывать поле).
async function publishVenue(client, venue, { actorAdminId }) {
  const today = todayUTC();
  const trialEndsOnStr = formatDateOnly(addDaysUTC(today, TRIAL_DAYS));

  return transitionStatus(client, venue, {
    toStatus: 'trial',
    reason: 'published',
    actorAdminId,
    extra: {
      published_at: new Date(),
      trial_started_at: venue.trial_started_at || new Date(),
      trial_ends_on: trialEndsOnStr,
      subscription_until: trialEndsOnStr,
    },
  });
}

// trial/grace/suspended/archived -> active. Вызывается после реальной оплаты (продление
// подписки суперадмином, подтверждение payment_claim в промте 1.4) — платёж всегда означает
// "активна", даже если до этого шёл бесплатный триал или заведение простаивало в archived:
// в рамках этого промта archived не удаляет данные, только помечает к удалению (сам процесс
// удаления не реализован), так что реальная оплата — законный способ вернуться, без ручного
// вмешательства суперадмина. draft не трогаем: там ещё нет самой подписки, оплата до публикации
// не имеет смысла (см. guard в POST /admin/subscription/claim).
async function reviveToActiveIfNeeded(client, venue, { actorAdminId, reason }) {
  if (!['trial', 'grace', 'suspended', 'archived'].includes(venue.status)) return venue;
  return transitionStatus(client, venue, { toStatus: 'active', reason, actorAdminId, extra: {} });
}

// Куда должен перейти статус ПРЯМО СЕЙЧАС, глядя только на subscription_until/suspended_at —
// используется и почасовым пересчётом (bot/worker/scheduler.js), и как защитная проверка при
// продлении подписки. draft/archived не меняются автоматически никогда — выход из них только
// через publishVenue (draft) или ручное решение суперадмина (archived, вне рамок этого промта).
function computeTargetStatus(venue, today) {
  if (venue.status === 'draft' || venue.status === 'archived') return venue.status;

  const subUntil = venue.subscription_until ? parseDateOnly(venue.subscription_until) : null;
  const daysUntilExpiry = subUntil ? diffDaysUTC(subUntil, today) : -Infinity;

  if (daysUntilExpiry >= 0) {
    return venue.status === 'trial' ? 'trial' : 'active';
  }

  const daysExpired = -daysUntilExpiry;
  if (daysExpired <= GRACE_DAYS) return 'grace';

  if (venue.status === 'suspended' && venue.suspended_at) {
    const daysSinceSuspended = diffDaysUTC(today, truncateToDateUTC(new Date(venue.suspended_at)));
    if (daysSinceSuspended > ARCHIVE_AFTER_SUSPENDED_DAYS) return 'archived';
  }
  return 'suspended';
}

// Напоминание для САМОГО заведения (не владельца сервиса): Telegram, если у заведения есть
// привязанный owner_telegram_id (промт 1.5, "привязка Telegram к admins" — приоритетнее почты,
// доставляется мгновенно и не попадает в спам), иначе email, иначе задача владельцу сервиса
// связаться вручную — этот путь предусмотрен самим промтом 1.3 как явный фолбэк, а не сокращение
// объёма работы.
async function notifyVenue(client, venue, { template, payload, dedupKey }) {
  if (venue.owner_telegram_id) {
    return notificationModel.enqueue(client, {
      channel: 'telegram', recipient: String(venue.owner_telegram_id), template, payload, lang: venue.lang_default || 'ru', dedupKey,
    });
  }
  if (venue.email) {
    return notificationModel.enqueue(client, {
      channel: 'email', recipient: venue.email, template, payload, lang: venue.lang_default || 'ru', dedupKey,
    });
  }
  for (const ownerId of env.OWNER_TELEGRAM_IDS) {
    await notificationModel.enqueue(client, {
      channel: 'telegram',
      recipient: String(ownerId),
      template: 'manual_contact_needed',
      payload: { venue_name: venue.name, venue_id: venue.id, reason: template },
      lang: 'ru',
      dedupKey: dedupKey ? `${dedupKey}:owner:${ownerId}` : null,
    });
  }
  return null;
}

async function notifyServiceOwner(client, { template, payload, dedupKey }) {
  for (const ownerId of env.OWNER_TELEGRAM_IDS) {
    await notificationModel.enqueue(client, {
      channel: 'telegram',
      recipient: String(ownerId),
      template,
      payload,
      lang: 'ru',
      dedupKey: dedupKey ? `${dedupKey}:owner:${ownerId}` : null,
    });
  }
}

module.exports = {
  TRIAL_DAYS,
  GRACE_DAYS,
  ARCHIVE_AFTER_SUSPENDED_DAYS,
  checkPublishReadiness,
  transitionStatus,
  publishVenue,
  reviveToActiveIfNeeded,
  computeTargetStatus,
  notifyVenue,
  notifyServiceOwner,
};
