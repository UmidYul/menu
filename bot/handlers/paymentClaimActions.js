const { t } = require('../../src/i18n');
const paymentClaimModel = require('../../src/models/paymentClaimModel');
const payment = require('../../src/services/payment');
const { isOwner } = require('../lib/owner');
const pendingRejectReason = require('../lib/pendingRejectReason');

function register(bot) {
  bot.action(/^claim:confirm:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery();
    const claimId = Number(ctx.match[1]);
    const lang = ctx.state.lang;

    try {
      const result = await payment.confirmPayment(claimId, null);
      if (result.alreadyProcessed) {
        await ctx.answerCbQuery(t('bot.paymentClaim.alreadyProcessed', lang), { show_alert: true });
        return;
      }
      await ctx.answerCbQuery();
      await ctx.reply(t('bot.paymentClaim.confirmed', lang, {
        venueName: result.venue.name,
        until: result.venue.subscription_until,
      }));
    } catch (err) {
      console.error('bot: не удалось подтвердить заявку на оплату', claimId, err);
      await ctx.answerCbQuery();
      await ctx.reply(t('bot.paymentClaim.confirmFailed', lang));
    }
  });

  bot.action(/^claim:reject:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.answerCbQuery();
    const claimId = Number(ctx.match[1]);
    const lang = ctx.state.lang;

    const claim = await paymentClaimModel.findById(claimId);
    if (!claim || claim.status !== 'pending') {
      await ctx.answerCbQuery(t('bot.paymentClaim.alreadyProcessed', lang), { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();

    pendingRejectReason.expect(ctx.from.id, 'claim', claimId);
    await ctx.reply(t('bot.paymentClaim.askRejectReason', lang));
  });
}

// Вызывается из fallback.js ДО общей обработки — см. комментарий в leadActions.js о peekType.
async function tryConsumeRejectReason(ctx) {
  if (!isOwner(ctx.from.id)) return false;
  if (pendingRejectReason.peekType(ctx.from.id) !== 'claim') return false;
  const entry = pendingRejectReason.consume(ctx.from.id);
  const claimId = entry && entry.id;
  if (!claimId) return false;

  const reason = ctx.message.text;
  const lang = ctx.state.lang;

  const result = await payment.rejectClaim(claimId, null, reason);
  if (result.alreadyProcessed) {
    await ctx.reply(t('bot.paymentClaim.alreadyProcessed', lang));
    return true;
  }
  await ctx.reply(t('bot.paymentClaim.rejected', lang));
  return true;
}

module.exports = { register, tryConsumeRejectReason };
