const { domainToASCII } = require('node:url');

// Промт 3.7: домен хранится в нижнем регистре, без протокола и слэшей, кириллица — в punycode.
// Вся нормализация собрана здесь, чтобы «тот же домен» означало одно и то же везде: при
// добавлении в админке, при поиске по входящему Host и при сравнении с собственным доменом
// сервиса. Разъедься эти три места — и домен, добавленный как «МойКафе.uz», перестал бы
// находиться по запросу на `xn--...uz`.

// Ограничения из RFC 1035: метка до 63 символов, всё имя до 253.
const MAX_LABEL_LENGTH = 63;
const MAX_DOMAIN_LENGTH = 253;
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Приводит произвольный ввод к каноническому виду или возвращает null, если это не домен.
// Возвращает именно null, а не бросает: у вызывающего кода (валидатор формы, middleware
// маршрутизации) на «не домен» разные ответы, и исключение здесь только мешало бы.
function normalizeDomain(input) {
  if (typeof input !== 'string') return null;

  let value = input.trim().toLowerCase();
  if (!value) return null;

  // Люди копируют адрес из строки браузера целиком. Протокол, путь, порт и завершающая точка
  // корня — не часть домена, и требовать от владельца вычистить их вручную незачем.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split('/')[0];
  value = value.split('?')[0];
  value = value.split('#')[0];
  // Порт отбрасываем, но только настоящий: у IPv6-литерала двоеточий много, а такой «домен»
  // нам всё равно не подходит и отсеется ниже.
  value = value.replace(/:\d+$/, '');
  value = value.replace(/\.$/, '');
  if (!value) return null;

  // Кириллица -> punycode. domainToASCII возвращает пустую строку на том, что не является
  // доменным именем вовсе, — это и есть проверка на мусор вроде пробелов и подчёркиваний.
  const ascii = domainToASCII(value);
  if (!ascii) return null;

  if (ascii.length > MAX_DOMAIN_LENGTH) return null;

  const labels = ascii.split('.');
  // Минимум две метки: одноуровневое имя (`localhost`) доменом заведения быть не может.
  if (labels.length < 2) return null;
  if (labels.some((label) => label.length === 0 || label.length > MAX_LABEL_LENGTH)) return null;
  if (labels.some((label) => !LABEL_PATTERN.test(label))) return null;
  // Последняя метка — зона: либо обычные буквы (.uz, .com), либо punycode-зона (.рф -> xn--p1ai,
  // цифры в ней законны). Заодно отсекает IP-адреса, которые доходят сюда как числовые метки:
  // ни под то, ни под другое они не подходят.
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld) && !/^xn--[a-z0-9-]+$/.test(tld)) return null;

  return ascii;
}

// «Тот же домен без www» и «тот же домен с www» — пара, которую промт называет основным
// и алиасом. Нужна и при добавлении (предложить второй), и при 301-редиректе между ними.
function stripWww(domain) {
  return domain.startsWith('www.') ? domain.slice(4) : domain;
}

function withWww(domain) {
  return domain.startsWith('www.') ? domain : `www.${domain}`;
}

// Два домена — это www-пара одного и того же имени.
function isWwwPair(a, b) {
  return a !== b && stripWww(a) === stripWww(b);
}

// Punycode -> Unicode, ТОЛЬКО для показа владельцу: на экране «xn--80ak6aa92e.uz» вместо
// собственного домена выглядит как ошибка сервиса. В БД и во всех сравнениях по-прежнему ASCII.
//
// Своя реализация, а не модуль punycode: тот объявлен устаревшим в Node и печатает
// предупреждение при require. Обратного преобразования в node:url нет (domainToUnicode есть,
// но он не экспортируется из node:url в CommonJS-сборке), а нужен здесь только декодер —
// RFC 3492, метка за меткой. Метка, которую не удалось разобрать, возвращается как есть:
// показать punycode хуже, чем читаемое имя, но лучше, чем упасть на странице настроек.
function unicodeOf(domain) {
  return domain.split('.').map(decodeLabel).join('.');
}

const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;

function adaptBias(delta, numPoints, firstTime) {
  let d = firstTime ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN));
    k += PUNY_BASE;
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

function decodeLabel(label) {
  if (!label.startsWith('xn--')) return label;
  const encoded = label.slice(4);

  const lastDelimiter = encoded.lastIndexOf('-');
  const basic = lastDelimiter > 0 ? encoded.slice(0, lastDelimiter) : '';
  const digits = lastDelimiter > 0 ? encoded.slice(lastDelimiter + 1) : encoded;

  const output = Array.from(basic);
  let n = PUNY_INITIAL_N;
  let bias = PUNY_INITIAL_BIAS;
  let i = 0;
  let index = 0;

  while (index < digits.length) {
    const oldi = i;
    let w = 1;
    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (index >= digits.length) return label;
      const code = digits.charCodeAt(index);
      index += 1;
      let digit;
      if (code >= 0x30 && code <= 0x39) digit = code - 0x30 + 26;
      else if (code >= 0x61 && code <= 0x7a) digit = code - 0x61;
      else return label;

      i += digit * w;
      const t = k <= bias ? PUNY_TMIN : Math.min(k - bias, PUNY_TMAX);
      if (digit < t) break;
      w *= PUNY_BASE - t;
    }

    bias = adaptBias(i - oldi, output.length + 1, oldi === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    output.splice(i, 0, String.fromCodePoint(n));
    i += 1;
  }

  return output.join('');
}

module.exports = {
  normalizeDomain, stripWww, withWww, isWwwPair, unicodeOf, MAX_DOMAIN_LENGTH,
};
