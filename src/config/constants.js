const PRICE_MONTH_UZS = 60000;
const PRICE_MONTH_OLD_UZS = 100000;
const FREE_TRIAL_MONTHS = 1;
const DISCOUNT_PERCENT = Math.round((1 - PRICE_MONTH_UZS / PRICE_MONTH_OLD_UZS) * 100);

// Скидка за предоплату периода целиком (промт 1.4) — отдельно от DISCOUNT_PERCENT выше (это
// "цена сейчас vs обычная цена", а не "длиннее период — больше скидка"). Проценты — продуктовое
// решение, не из промта: 1 мес. без скидки (это и есть базовая PRICE_MONTH_UZS), дальше растёт
// с периодом.
const PERIOD_DISCOUNTS = { 1: 0, 3: 10, 6: 15, 12: 20 };

// Итоговая сумма за период с учётом скидки, округлённая до целых сумов (валюта одна — UZS,
// копеек не бывает).
function calculatePeriodPrice(months) {
  const discountPercent = PERIOD_DISCOUNTS[months] || 0;
  const raw = PRICE_MONTH_UZS * months * (1 - discountPercent / 100);
  return Math.round(raw);
}

module.exports = {
  SERVICE_NAME: 'qr.menu',
  PRICE_MONTH_UZS,
  PRICE_MONTH_OLD_UZS,
  FREE_TRIAL_MONTHS,
  DISCOUNT_PERCENT,
  PERIOD_DISCOUNTS,
  calculatePeriodPrice,
};
