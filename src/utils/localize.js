const { LANG_FALLBACKS, DEFAULT_LANG } = require('../i18n');

// Возвращает row[field + '_' + lang], если непусто, иначе идёт по цепочке фолбэков этого языка
// (см. LANG_FALLBACKS в src/i18n/index.js). Пусто везде — null, шаблон не должен рендерить блок.
function pickLocalized(row, field, lang) {
  const chain = LANG_FALLBACKS[lang] || LANG_FALLBACKS[DEFAULT_LANG];
  for (const candidate of chain) {
    const value = row[`${field}_${candidate}`];
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

module.exports = { pickLocalized };
