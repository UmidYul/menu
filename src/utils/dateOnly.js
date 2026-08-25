const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// value: Date (as returned by pg for a `date` column) or 'YYYY-MM-DD' string.
function parseDateOnly(value) {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDateOnly(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Rejects calendar dates that don't round-trip (e.g. 2026-02-30), which Date.UTC would
// otherwise silently roll forward into the next month.
function isValidDateOnly(str) {
  if (typeof str !== 'string' || !DATE_ONLY_REGEX.test(str)) return false;
  return formatDateOnly(parseDateOnly(str)) === str;
}

function addMonthsUTC(date, months) {
  const result = new Date(date.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function diffDaysUTC(date, fromDate) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((date.getTime() - fromDate.getTime()) / MS_PER_DAY);
}

module.exports = {
  DATE_ONLY_REGEX,
  todayUTC,
  parseDateOnly,
  formatDateOnly,
  isValidDateOnly,
  addMonthsUTC,
  diffDaysUTC,
};
