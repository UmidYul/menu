const UZ_PHONE_REGEX = /^\+998\d{9}$/;

// Приводит разные варианты ввода узбекского номера к единому +998XXXXXXXXX:
// '901234567', '90 123 45 67', '998901234567', '+998 (90) 123-45-67' — всё к одному виду.
// Возвращает null, если после нормализации не похоже на валидный номер.
function normalizeUzPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');

  let normalized;
  if (digits.length === 9) {
    normalized = `+998${digits}`;
  } else if (digits.length === 12 && digits.startsWith('998')) {
    normalized = `+${digits}`;
  } else {
    return null;
  }

  return UZ_PHONE_REGEX.test(normalized) ? normalized : null;
}

function isValidUzPhone(value) {
  return typeof value === 'string' && UZ_PHONE_REGEX.test(value);
}

module.exports = { normalizeUzPhone, isValidUzPhone, UZ_PHONE_REGEX };
