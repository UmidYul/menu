const { message } = require('telegraf/filters');
const { t } = require('../../src/i18n');
const venueModel = require('../../src/models/venueModel');
const groupLinkModel = require('../../src/models/venueTelegramGroupLinkModel');

// Код привязки — ровно 6 символов из того же алфавита, что генерирует модель. Проверяем формат
// ДО похода в БД и требуем, чтобы код был всем содержимым сообщения: иначе каждое сообщение в
// группе (персонал переписывается) превращалось бы в запрос к базе, а случайное «ABCDEF» внутри
// длинной фразы — в попытку привязки.
const CODE_RE = new RegExp(`^[${groupLinkModel.CODE_ALPHABET}]{${groupLinkModel.CODE_LENGTH}}$`, 'i');

function isGroupChat(ctx) {
  return ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
}

async function handleGroupText(ctx, next) {
  if (!isGroupChat(ctx)) return next();

  const text = (ctx.message.text || '').trim();
  if (!CODE_RE.test(text)) return next();

  const lang = ctx.state.lang;
  const claimed = await groupLinkModel.claim(text);
  if (!claimed) {
    // Код неверный/просрочен/уже использован. Отвечаем — но только потому, что сообщение и было
    // похоже на код: на обычную болтовню в группе бот молчит (см. fallback.js).
    await ctx.reply(t('bot.groupLink.invalidCode', lang));
    return undefined;
  }

  // Одна группа — одно заведение: иначе заказы двух заведений валились бы в один чат, а
  // обратный поиск «чей это чат» (venueModel.findByTelegramChatId, нужен для пометки связи
  // разорванной) стал бы неоднозначным.
  const existing = await venueModel.findByTelegramChatId(ctx.chat.id);
  if (existing && existing.id !== claimed.venue_id) {
    await ctx.reply(t('bot.groupLink.chatAlreadyLinked', lang, { venueName: existing.name }));
    return undefined;
  }

  const chatTitle = ctx.chat.title || String(ctx.chat.id);
  const venue = await venueModel.linkTelegramChat(claimed.venue_id, ctx.chat.id, chatTitle);

  // Промт 2.4: «удаляет сообщение с кодом, если у него есть права». Без прав администратора
  // Telegram вернёт ошибку — это не повод ронять привязку, код и так уже погашен.
  try {
    await ctx.deleteMessage(ctx.message.message_id);
  } catch (err) {
    console.log('bot: не удалось удалить сообщение с кодом привязки (нет прав) —', err.message);
  }

  // Само подтверждение и есть требуемое промтом «тестовое сообщение»: если бот не может писать
  // в группу, отправка бросит исключение — тогда помечаем связь разорванной, и админка покажет
  // предупреждение вместо «всё готово».
  try {
    await ctx.reply(t('bot.groupLink.linked', lang, { venueName: venue.name }));
  } catch (err) {
    console.error('bot: привязка группы прошла, но отправить подтверждение не удалось', err.message);
    await venueModel.markTelegramChatBroken(venue.id);
  }

  return undefined;
}

function register(bot) {
  // Регистрируется ДО fallback.js: тот забирает любой текст и не передаёт управление дальше.
  bot.on(message('text'), handleGroupText);
}

module.exports = { register };
