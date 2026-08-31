// Пока владелец не написал причину отклонения — какую заявку и от какого владельца мы ждём.
// В памяти процесса, как и supportBridge: это оперативное состояние диалога, не нужно переживать
// перезапуск бота.
const pending = new Map(); // ownerTelegramId -> leadId

function expect(ownerTelegramId, leadId) {
  pending.set(ownerTelegramId, leadId);
}

function consume(ownerTelegramId) {
  const leadId = pending.get(ownerTelegramId);
  if (leadId === undefined) return null;
  pending.delete(ownerTelegramId);
  return leadId;
}

module.exports = { expect, consume };
