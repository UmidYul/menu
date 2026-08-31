const telegramUserModel = require('../../src/models/telegramUserModel');
const { SUPPORTED_LANGS, DEFAULT_LANG } = require('../../src/i18n');

// 'uz-UZ' -> 'uz', 'en' -> 'en', неизвестный/отсутствующий код -> дефолт сервиса.
function detectLangFromCode(languageCode) {
  if (!languageCode) return DEFAULT_LANG;
  const primary = languageCode.split('-')[0].toLowerCase();
  return SUPPORTED_LANGS.includes(primary) ? primary : DEFAULT_LANG;
}

// Подтягивает/создаёт запись в telegram_users на каждое обновление. При первом контакте язык
// берётся из ctx.from.language_code (это только предположение — пользователь подтверждает или
// меняет его кнопками в handlers/start.js), у уже существующих — лишь обновляются username/
// last_seen_at, lang не трогается.
async function userLang(ctx, next) {
  if (!ctx.from) return next();

  const { id, username, first_name: firstName, language_code: languageCode } = ctx.from;
  const { user, isNew } = await telegramUserModel.touch(id, {
    username,
    firstName,
    lang: detectLangFromCode(languageCode),
  });

  ctx.state.user = user;
  ctx.state.isNewUser = isNew;
  ctx.state.lang = user.lang;

  return next();
}

module.exports = { userLang, detectLangFromCode };
