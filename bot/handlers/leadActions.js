const { t } = require('../../src/i18n');
const leadModel = require('../../src/models/leadModel');
const leadApproval = require('../../src/services/leadApproval');
const { isOwner } = require('../lib/owner');
const pendingRejectReason = require('../lib/pendingRejectReason');

function register(bot) {
  bot.action(/^lead:approve:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery();
    const leadId = Number(ctx.match[1]);
    const lang = ctx.state.lang;

    const lead = await leadModel.findById(leadId);
    if (!lead || !['new', 'contacted'].includes(lead.status)) {
      await ctx.answerCbQuery(t('bot.lead.alreadyProcessed', lang), { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();

    try {
      const defaults = await leadApproval.buildApprovalDefaults(lead);
      const { venue } = await leadApproval.approveLead(lead, { ...defaults, processedBy: null });
      await ctx.reply(t('bot.lead.approved', lang, {
        venueName: venue.name,
        slug: venue.slug,
        adminLogin: defaults.adminLogin,
        adminPassword: defaults.adminPassword,
      }));
    } catch (err) {
      console.error('bot: не удалось одобрить заявку', leadId, err);
      await ctx.reply(t('bot.lead.approveFailed', lang));
    }
  });

  bot.action(/^lead:reject:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery();
    const leadId = Number(ctx.match[1]);
    const lang = ctx.state.lang;

    const lead = await leadModel.findById(leadId);
    if (!lead || !['new', 'contacted'].includes(lead.status)) {
      await ctx.answerCbQuery(t('bot.lead.alreadyProcessed', lang), { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();

    pendingRejectReason.expect(ctx.from.id, leadId);
    await ctx.reply(t('bot.lead.askRejectReason', lang, { venueName: lead.venue_name }));
  });
}

// Вызывается из fallback.js ДО общей обработки — если для этого владельца ждём причину
// отклонения, следующее его сообщение целиком уходит в неё, а не в форвард поддержки.
async function tryConsumeRejectReason(ctx) {
  if (!isOwner(ctx.from.id)) return false;
  const leadId = pendingRejectReason.consume(ctx.from.id);
  if (!leadId) return false;

  const reason = ctx.message.text;
  const lang = ctx.state.lang;
  const lead = await leadModel.findById(leadId);
  if (!lead) {
    await ctx.reply(t('bot.lead.alreadyProcessed', lang));
    return true;
  }

  await leadApproval.rejectLead(lead, { reason, processedBy: null });
  await ctx.reply(t('bot.lead.rejected', lang, { venueName: lead.venue_name }));
  return true;
}

module.exports = { register, tryConsumeRejectReason };
