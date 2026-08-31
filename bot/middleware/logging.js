// Структурный лог на каждое обновление: тип, telegram_id, время обработки — без содержимого
// сообщений (в логах не должно быть переписки пользователей).
async function logging(ctx, next) {
  const start = Date.now();
  const telegramId = ctx.from && ctx.from.id;
  const type = ctx.updateType;
  try {
    await next();
  } finally {
    console.log(`[bot] ${type} telegram_id=${telegramId || '-'} ${Date.now() - start}ms`);
  }
}

module.exports = logging;
