const { pool } = require('../../src/config/db');
const venueModel = require('../../src/models/venueModel');
const venueLifecycle = require('../../src/services/venueLifecycle');
const {
  todayUTC, parseDateOnly, formatDateOnly, diffDaysUTC, truncateToDateUTC,
} = require('../../src/utils/dateOnly');

// Раз в час (не раз в сутки — переживает перезапуск без потери целого дня), идемпотентно —
// каждое конкретное действие (переход статуса, конкретное напоминание) защищено либо проверкой
// "статус уже такой, не переход" (venueLifecycle.transitionStatus), либо dedup_key в notifications
// (см. notificationModel.enqueue). Повторный/более частый запуск ничего не задваивает.
const TICK_INTERVAL_MS = 60 * 60 * 1000;
const GRACE_WARNING_AT_DAY = 3;
const ARCHIVE_WARNING_DAYS_BEFORE = 7;

// Напоминания "приближается дата" — не зависят от того, произойдёт ли в этот же тик переход
// статуса (см. комментарий в processVenue). Используют pool напрямую, не транзакцию: не нужно
// быть атомарными ни с чем ещё, а от повторной отправки защищает сам dedup_key.
async function checkReminders(venue, today) {
  if (!['trial', 'active', 'grace', 'suspended'].includes(venue.status)) return;

  const subUntil = venue.subscription_until ? parseDateOnly(venue.subscription_until) : null;
  const daysUntilExpiry = subUntil ? diffDaysUTC(subUntil, today) : null;

  if (['trial', 'active'].includes(venue.status) && daysUntilExpiry !== null) {
    const upcoming = { 7: 'subscription_reminder_7d', 3: 'subscription_reminder_3d', 1: 'subscription_reminder_1d' };
    if (upcoming[daysUntilExpiry]) {
      await venueLifecycle.notifyVenue(pool, venue, {
        template: upcoming[daysUntilExpiry],
        payload: { venue_name: venue.name, until: venue.subscription_until },
        dedupKey: `sub_${upcoming[daysUntilExpiry]}:${venue.id}:${venue.subscription_until}`,
      });
    } else if (daysUntilExpiry === 0) {
      await venueLifecycle.notifyVenue(pool, venue, {
        template: 'subscription_expiring_today',
        payload: { venue_name: venue.name },
        dedupKey: `sub_expiring_today:${venue.id}:${venue.subscription_until}`,
      });
    }
  }

  if (venue.status === 'grace' && daysUntilExpiry !== null) {
    const daysExpired = -daysUntilExpiry;
    if (daysExpired === GRACE_WARNING_AT_DAY) {
      const graceDaysLeft = Math.max(0, venueLifecycle.GRACE_DAYS - daysExpired);
      await venueLifecycle.notifyVenue(pool, venue, {
        template: 'subscription_grace_warning',
        payload: { venue_name: venue.name, days: graceDaysLeft },
        dedupKey: `sub_grace_warn:${venue.id}:${venue.subscription_until}`,
      });
    }
  }

  if (venue.status === 'suspended' && venue.suspended_at) {
    const suspendedDateStr = formatDateOnly(truncateToDateUTC(new Date(venue.suspended_at)));
    const daysSinceSuspended = diffDaysUTC(today, parseDateOnly(suspendedDateStr));
    const daysUntilArchive = venueLifecycle.ARCHIVE_AFTER_SUSPENDED_DAYS - daysSinceSuspended;
    if (daysUntilArchive === ARCHIVE_WARNING_DAYS_BEFORE) {
      await venueLifecycle.notifyVenue(pool, venue, {
        template: 'subscription_archive_warning',
        payload: { venue_name: venue.name, days: ARCHIVE_WARNING_DAYS_BEFORE },
        dedupKey: `sub_archive_warn:${venue.id}:${suspendedDateStr}`,
      });
    }
  }
}

async function applyTransitionIfNeeded(venue, today) {
  const targetStatus = venueLifecycle.computeTargetStatus(venue, today);
  if (targetStatus === venue.status) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const extra = {};
    if (targetStatus === 'suspended') extra.suspended_at = new Date();
    if (targetStatus === 'archived') extra.archived_at = new Date();

    await venueLifecycle.transitionStatus(client, venue, {
      toStatus: targetStatus, reason: 'scheduler', actorAdminId: null, extra,
    });

    if (targetStatus === 'suspended') {
      const todayStr = formatDateOnly(today);
      await venueLifecycle.notifyVenue(client, venue, {
        template: 'venue_suspended',
        payload: { venue_name: venue.name },
        dedupKey: `sub_suspended:${venue.id}:${todayStr}`,
      });
      await venueLifecycle.notifyServiceOwner(client, {
        template: 'venue_suspended_owner',
        payload: { venue_name: venue.name, venue_id: venue.id },
        dedupKey: `sub_suspended_owner:${venue.id}:${todayStr}`,
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function processVenue(venue, today) {
  await checkReminders(venue, today);
  await applyTransitionIfNeeded(venue, today);
}

function startLifecycleScheduler() {
  let stopped = false;
  let timer = null;
  let inFlight = null;

  async function tick() {
    inFlight = (async () => {
      const today = todayUTC();
      let venues;
      try {
        venues = await venueModel.listForLifecycleRecalc();
      } catch (err) {
        console.error('scheduler: не удалось получить список заведений', err);
        return;
      }

      for (const venue of venues) {
        try {
          await processVenue(venue, today);
        } catch (err) {
          console.error('scheduler: ошибка пересчёта статуса заведения', venue.id, err);
        }
      }
    })();

    await inFlight;
    inFlight = null;
    if (!stopped) timer = setTimeout(tick, TICK_INTERVAL_MS);
  }

  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
  };
}

module.exports = { startLifecycleScheduler };
