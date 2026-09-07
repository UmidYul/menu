const crypto = require('crypto');
const env = require('../config/env');
const { todayUTC, formatDateOnly } = require('./dateOnly');

// Псевдонимизация гостя для аналитики (промт 3.2) — отдельная функция от utils/hashIp.js:
// та хеширует только IP для антиспам-паттернов (1.5), эта — IP+User-Agent для сопоставления
// "один и тот же гость за сутки" в menu_events/admin_session_hashes. Соль — SESSION_SECRET
// плюс календарный день (UTC, как и весь остальной проект — см. dateOnly.js): сутки спустя
// один и тот же IP+UA даёт другой хеш, сопоставить активность гостя между днями нельзя.
// Сырые IP и User-Agent нигде не сохраняются — только этот хеш.
function sessionHash(ip, userAgent) {
  const day = formatDateOnly(todayUTC());
  return crypto
    .createHash('sha256')
    .update(`${env.SESSION_SECRET}:${day}:${ip || ''}:${userAgent || ''}`)
    .digest('hex');
}

module.exports = { sessionHash };
