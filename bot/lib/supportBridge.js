// Связывает сообщение, пересланное владельцу, с исходным пользователем — чтобы Reply на него
// в Telegram ушёл нужному человеку. Только в памяти процесса: это чат поддержки "на скорую руку"
// для каркаса бота, не критично потерять сопоставление при перезапуске.
const pending = new Map(); // `${ownerChatId}:${forwardedMessageId}` -> { telegramId, name }

function remember(ownerChatId, forwardedMessageId, telegramId, name) {
  pending.set(`${ownerChatId}:${forwardedMessageId}`, { telegramId, name });
}

function resolve(ownerChatId, repliedToMessageId) {
  return pending.get(`${ownerChatId}:${repliedToMessageId}`) || null;
}

// "Осмысленное" сообщение — не пустое, не только эмодзи/пунктуация/цифры, не микроскопическое.
function looksMeaningful(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  return /\p{L}/u.test(trimmed);
}

module.exports = { remember, resolve, looksMeaningful };
