const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const SWEEP_INTERVAL_MS = 5 * 60_000;

const hits = new Map(); // telegram_id -> timestamps[] за последнее окно

// Не больше 20 обновлений в минуту с одного telegram_id — дальше молча игнорируем (не отвечаем
// "вы флудите", это только удвоило бы трафик). Простая память в процессе, без Redis — на старте
// сервиса объём не тот, чтобы это было узким местом.
function antiflood(ctx, next) {
  const telegramId = ctx.from && ctx.from.id;
  if (!telegramId) return next();

  const now = Date.now();
  const recent = (hits.get(telegramId) || []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(telegramId, recent);
    return;
  }

  recent.push(now);
  hits.set(telegramId, recent);
  return next();
}

// Иначе Map растёт бесконечно, пока процесс жив — раз в 5 минут выбрасываем тех, у кого не было
// обновлений за последнее окно.
setInterval(() => {
  const now = Date.now();
  for (const [telegramId, timestamps] of hits) {
    if (!timestamps.some((t) => now - t < WINDOW_MS)) hits.delete(telegramId);
  }
}, SWEEP_INTERVAL_MS).unref();

module.exports = antiflood;
