const { todayUTC, parseDateOnly, diffDaysUTC } = require('./dateOnly');

const SUBSCRIPTION_EXPIRING_SOON_DAYS = 7;

function computeSubscriptionStatus(subscriptionUntil) {
  if (!subscriptionUntil) return 'overdue';
  const daysLeft = diffDaysUTC(parseDateOnly(subscriptionUntil), todayUTC());
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= SUBSCRIPTION_EXPIRING_SOON_DAYS) return 'expiring';
  return 'active';
}

module.exports = { computeSubscriptionStatus, SUBSCRIPTION_EXPIRING_SOON_DAYS };
