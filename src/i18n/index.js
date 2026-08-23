const ru = require('./ru.json');
const uz = require('./uz.json');

const SUPPORTED_LANGS = ['ru', 'uz'];
const DEFAULT_LANG = 'ru';

const dictionaries = { ru, uz };

function getNested(obj, dotPath) {
  return dotPath.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// Переводит ключ (dot-notation, например "categories.errorHasItems") на нужный язык.
// Если перевода нет для lang — фолбэк на русский, если нет нигде — возвращает сам ключ
// (и предупреждает в консоли, чтобы пробел в словаре не остался незамеченным).
function t(key, lang, params) {
  const dict = dictionaries[lang] || dictionaries[DEFAULT_LANG];
  let value = getNested(dict, key);
  if (value === undefined) {
    value = getNested(dictionaries[DEFAULT_LANG], key);
  }
  if (value === undefined) {
    console.warn(`[i18n] Отсутствует перевод для ключа: ${key}`);
    return key;
  }
  return interpolate(value, params);
}

module.exports = { t, SUPPORTED_LANGS, DEFAULT_LANG };
