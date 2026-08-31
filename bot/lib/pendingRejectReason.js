// Пока владелец не написал причину отклонения — какую заявку (лид или заявку на оплату) и от
// какого владельца мы ждём. В памяти процесса, как и supportBridge: это оперативное состояние
// диалога, не нужно переживать перезапуск бота. type различает 'lead' (промт 1.2) и 'claim'
// (промт 1.4, заявка на оплату) — один и тот же владелец в моменте ждёт причину только по
// одной из них, второе нажатие "Отклонить" (на другую заявку) просто перезатирает ожидание.
const pending = new Map(); // ownerTelegramId -> { type: 'lead' | 'claim', id }

function expect(ownerTelegramId, type, id) {
  pending.set(ownerTelegramId, { type, id });
}

// Непотребляющая проверка — нужна, чтобы обработчик "не своего" типа (лид/заявка на оплату)
// не забирал чужое ожидание себе первым: fallback.js последовательно спрашивает peekType()
// у lead- и claim-обработчиков, и только тот, чей тип совпал, вызывает consume().
function peekType(ownerTelegramId) {
  const entry = pending.get(ownerTelegramId);
  return entry ? entry.type : null;
}

function consume(ownerTelegramId) {
  const entry = pending.get(ownerTelegramId);
  if (entry === undefined) return null;
  pending.delete(ownerTelegramId);
  return entry;
}

module.exports = { expect, peekType, consume };
