const { t } = require('../../src/i18n');
const venueModel = require('../../src/models/venueModel');
const notificationModel = require('../../src/models/notificationModel');
const leadModel = require('../../src/models/leadModel');
const { computeSubscriptionStatus } = require('../../src/utils/subscriptionStatus');
const { isOwner } = require('../lib/owner');

// /stats и /pending видят заведения, статус подписки, очередь уведомлений и (с промта 1.2)
// новые заявки на подключение. Запросов на оплату пока нет (появятся в 1.4) — futureNote
// честно об этом предупреждает.
async function buildStatsText(lang) {
  const venues = await venueModel.listAll();
  const active = venues.filter((v) => v.is_active).length;
  const bySubStatus = { active: 0, expiring: 0, overdue: 0 };
  venues.forEach((v) => {
    bySubStatus[computeSubscriptionStatus(v.subscription_until)] += 1;
  });
  const notifications = await notificationModel.countByStatus();
  const newLeads = await leadModel.countNew();

  return [
    t('bot.stats.heading', lang),
    t('bot.stats.venuesTotal', lang, { count: venues.length }),
    t('bot.stats.venuesActive', lang, { count: active }),
    t('bot.stats.subActive', lang, { count: bySubStatus.active }),
    t('bot.stats.subExpiring', lang, { count: bySubStatus.expiring }),
    t('bot.stats.subOverdue', lang, { count: bySubStatus.overdue }),
    t('bot.stats.leadsNew', lang, { count: newLeads }),
    t('bot.stats.notificationsPending', lang, { count: notifications.pending }),
    t('bot.stats.notificationsFailed', lang, { count: notifications.failed }),
    '',
    t('bot.stats.futureNote', lang),
  ].join('\n');
}

async function buildPendingText(lang) {
  const notifications = await notificationModel.countByStatus();
  const newLeads = await leadModel.countNew();
  const lines = [t('bot.pending.heading', lang)];

  if (notifications.failed === 0 && newLeads === 0) {
    lines.push(t('bot.pending.empty', lang));
  } else {
    if (newLeads > 0) lines.push(t('bot.pending.leadsNew', lang, { count: newLeads }));
    if (notifications.failed > 0) lines.push(t('bot.pending.failedNotifications', lang, { count: notifications.failed }));
  }

  lines.push('', t('bot.pending.futureNote', lang));
  return lines.join('\n');
}

function register(bot) {
  bot.command('stats', async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      await ctx.reply(t('bot.owner.notAuthorized', ctx.state.lang));
      return;
    }
    await ctx.reply(await buildStatsText(ctx.state.lang));
  });

  bot.command('pending', async (ctx) => {
    if (!isOwner(ctx.from.id)) {
      await ctx.reply(t('bot.owner.notAuthorized', ctx.state.lang));
      return;
    }
    await ctx.reply(await buildPendingText(ctx.state.lang));
  });
}

module.exports = { register };
