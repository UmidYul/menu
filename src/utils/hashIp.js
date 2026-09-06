const crypto = require('crypto');
const env = require('../config/env');

// Псевдонимизация IP: соль включает дату, так что хеш одного и того же IP меняется день ото дня —
// нельзя по хешу сопоставить активность за разные сутки, но в рамках одних суток одинаковые IP
// всё ещё дают одинаковый хеш (пригодно для анализа паттернов спама/перебора).
// SESSION_SECRET уже обязателен в env.js — отдельный секрет под это заводить незачем.
function hashIp(ip) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${env.SESSION_SECRET}:${day}:${ip}`).digest('hex');
}

module.exports = { hashIp };
