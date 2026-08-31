const env = require('../../src/config/env');

function isOwner(telegramId) {
  return env.OWNER_TELEGRAM_IDS.includes(Number(telegramId));
}

module.exports = { isOwner };
