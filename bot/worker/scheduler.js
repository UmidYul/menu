const { pool } = require('../../src/config/db');
const venueModel = require('../../src/models/venueModel');
const reviewModel = require('../../src/models/reviewModel');
const onboardingModel = require('../../src/models/onboardingModel');
const notificationModel = require('../../src/models/notificationModel');
const venueLifecycle = require('../../src/services/venueLifecycle');
const analyticsAggregation = require('../../src/services/analyticsAggregation');
const {
  todayUTC, parseDateOnly, formatDateOnly, diffDaysUTC, truncateToDateUTC, addDaysUTC,
} = require('../../src/utils/dateOnly');
const analyticsDashboard = require('../../src/services/analyticsDashboard');

// Раз в час (не раз в сутки — переживает перезапуск без потери целого дня), идемпотентно —
// каждое конкретное действие (переход статуса, конкретное напоминание) защищено либо проверкой
// "статус уже такой, не переход" (venueLifecycle.transitionStatus), либо dedup_key в notifications
// (см. notificationModel.enqueue). Повторный/более частый запуск ничего не задваивает.
const TICK_INTERVAL_MS = 60 * 60 * 1000;
const GRACE_WARNING_AT_DAY = 3;
const ARCHIVE_WARNING_DAYS_BEFORE = 7;

// Промт 1.6 — подсказки от бота застрявшим на онбординге. В отличие от остальных уведомлений
// в этом файле, у них нет фолбэка на email/владельца сервиса: без привязанного Telegram
// подсказку просто некому показать, а писать про это на почту не то же самое ("бот заметил,
// что вы застряли" по email выглядит иначе, чем то же сообщение от бота, с которым уже есть
// диалог) — соответствует формулировке промта "если заведение привязало Telegram и застряло".
const STUCK_NO_ITEMS_AT_DAY = 2;
const STUCK_DRAFT_AT_DAY = 5;
const QR_REMINDER_AT_DAY = 3;

async function checkOnboardingNudges(venue, today) {
  if (!venue.owner_telegram_id) return;
  const lang = venue.lang_default || 'ru';

  if (venue.status === 'draft') {
    const daysSinceCreated = diffDaysUTC(today, truncateToDateUTC(new Date(venue.created_at)));

    if (daysSinceCreated === STUCK_NO_ITEMS_AT_DAY) {
      // Проверяем ИМЕННО в момент отправки, а не считаем на будущее заранее (промт 1.6) —
      // к этому часу позиции вполне могли уже появиться.
      const counts = await onboardingModel.getChecklistCounts(venue.id);
      if (counts.item_count === 0) {
        await notificationModel.enqueue(pool, {
          channel: 'telegram',
          recipient: String(venue.owner_telegram_id),
          template: 'onboarding_stuck_no_items',
          payload: { venue_name: venue.name },
          lang,
          dedupKey: `onboarding_stuck_no_items:${venue.id}`,
        });
      }
    } else if (daysSinceCreated === STUCK_DRAFT_AT_DAY) {
      await notificationModel.enqueue(pool, {
        channel: 'telegram',
        recipient: String(venue.owner_telegram_id),
        template: 'onboarding_stuck_draft',
        payload: { venue_name: venue.name },
        lang,
        dedupKey: `onboarding_stuck_draft:${venue.id}`,
      });
    }
    return;
  }

  if (!venue.qr_downloaded_at && venue.published_at) {
    const daysSincePublish = diffDaysUTC(today, truncateToDateUTC(new Date(venue.published_at)));
    if (daysSincePublish === QR_REMINDER_AT_DAY) {
      await notificationModel.enqueue(pool, {
        channel: 'telegram',
        recipient: String(venue.owner_telegram_id),
        template: 'onboarding_qr_reminder',
        payload: { venue_name: venue.name },
        lang,
        dedupKey: `onboarding_qr_reminder:${venue.id}`,
      });
    }
  }
}

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

// Промт 3.2, раздел 4 "Экспорт и сводки". Только по понедельникам (UTC) — тик часовой, поэтому
// без проверки дня недели сообщение пыталось бы отправиться (и отсекалось бы только dedupKey)
// 24 раза за день впустую. Требует Telegram (некому показать иначе, тот же принцип, что и у
// checkOnboardingNudges выше — на email такая сводка не переводится тем же смыслом) и явного
// согласия владельца (venues.weekly_summary_enabled, включено по умолчанию, выключается на
// странице аналитики).
async function checkWeeklyAnalyticsSummary(venue, today) {
  if (today.getUTCDay() !== 1) return;
  if (!venue.owner_telegram_id || !venue.weekly_summary_enabled) return;

  // Прошедшая неделя пн-вс, заканчивающаяся вчера (сегодня — тот самый понедельник).
  const weekEnd = addDaysUTC(today, -1);
  const weekStart = addDaysUTC(weekEnd, -6);
  const lang = venue.lang_default || 'ru';

  const summary = await analyticsDashboard.buildWeeklySummary(venue, weekStart, weekEnd);
  // Промт 3.3. Границы недели — календарные даты (UTC), а created_at у отзыва — момент времени,
  // поэтому верхняя граница берётся полуоткрытой: [weekStart, weekEnd + 1 день).
  const reviews = venue.reviews_enabled
    ? await reviewModel.countByPeriod(venue.id, weekStart, addDaysUTC(weekEnd, 1))
    : { count: 0, average: null };

  await notificationModel.enqueue(pool, {
    channel: 'telegram',
    recipient: String(venue.owner_telegram_id),
    template: 'weekly_analytics_summary',
    payload: {
      venue_name: venue.name,
      total_views: summary.totalViews,
      trend_percent: summary.trendPercent,
      top_dishes: summary.topDishes,
      top_empty_searches: summary.topEmptySearches,
      reviews_count: reviews.count,
      reviews_average: reviews.average === null ? null : reviews.average.toFixed(1),
    },
    lang,
    // Ключ по началу недели (не по номеру недели ISO — тот же результат, но без отдельной
    // ISO-недели арифметики): один тик из 24 в понедельник реально отправит, остальные 23
    // молча ничего не сделают благодаря partial unique index на dedup_key.
    dedupKey: `weekly_summary:${venue.id}:${formatDateOnly(weekStart)}`,
  });
}

async function processVenue(venue, today) {
  await checkReminders(venue, today);
  await checkOnboardingNudges(venue, today);
  await checkWeeklyAnalyticsSummary(venue, today);
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

      // Промт 3.2 — не привязано к конкретному заведению (список заведений с событиями
      // analyticsAggregation берёт сам, из menu_events), поэтому вызывается отдельно от цикла
      // выше, а не изнутри processVenue. Ошибка здесь не должна прервать остальную часть тика.
      try {
        await analyticsAggregation.runHourlyTick();
      } catch (err) {
        console.error('scheduler: ошибка агрегации аналитики', err);
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
