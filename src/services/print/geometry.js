const path = require('path');
const fontkit = require('fontkit');

// Промт 3.4. Все макеты считаются в МИЛЛИМЕТРАХ (это единственная единица, в которой типография
// и владелец разговаривают), а в пункты PDF переводятся один раз на самой отрисовке.
const MM = 72 / 25.4;
const mm = (value) => value * MM;

// Вылеты под обрез: фон макета заходит за линию реза на 3 мм с каждой стороны, чтобы после
// подрезки не появилась белая полоска от смещения ножа.
const BLEED_MM = 3;
// Минимальный физический размер QR (промт 3.4): меньше 25 мм дешёвые камеры не читают.
const MIN_QR_MM = 25;
// Тихая зона вокруг QR — не меньше 4 модулей по стандарту; считается в модулях самого кода,
// поэтому живёт рядом с отрисовкой QR (см. qr.js), здесь только как общая константа.
const QUIET_ZONE_MODULES = 4;

const FONT_DIR = path.join(__dirname, '../../public/fonts/print');
const FONT_FILES = {
  serif: path.join(FONT_DIR, 'PlayfairDisplay.ttf'),
  sans: path.join(FONT_DIR, 'Manrope.ttf'),
};

// fontkit-инстансы кэшируются: файл читается один раз на процесс, а не на каждый макет.
const fontCache = new Map();
function loadFont(key) {
  if (!fontCache.has(key)) fontCache.set(key, fontkit.openSync(FONT_FILES[key]));
  return fontCache.get(key);
}

// Замеры делаются fontkit'ом ОБОИМИ бэкендами (и pdfkit, и SVG-предпросмотром) — иначе
// предпросмотр разъехался бы с реальным PDF на переносах строк и автоподборе кегля.
// Возвращает ширину строки в миллиметрах при заданном кегле (кегль — в пунктах, как в вебе).
function measureTextMm(text, { font = 'sans', size = 10 } = {}) {
  const f = loadFont(font);
  const run = f.layout(String(text));
  return (run.advanceWidth / f.unitsPerEm) * size / MM;
}

// Промт 3.4, edge case «очень длинное название заведения»: сначала уменьшаем кегль до предела,
// потом переносим на две строки, потом обрезаем многоточием. Макет не должен разъезжаться.
function fitText(text, { font = 'sans', size, minSize = size * 0.6, maxWidthMm, maxLines = 2 }) {
  const clean = String(text || '').trim();
  if (!clean) return { lines: [], size };

  // 1. Пытаемся уместить в одну строку, уменьшая кегль.
  for (let s = size; s >= minSize; s -= 0.5) {
    if (measureTextMm(clean, { font, size: s }) <= maxWidthMm) return { lines: [clean], size: s };
  }
  if (maxLines < 2) return { lines: [truncateToWidth(clean, { font, size: minSize, maxWidthMm })], size: minSize };

  // 2. Не влезло — переносим по словам на maxLines строк, снова подбирая кегль.
  // Проверяется НЕ ТОЛЬКО число строк, но и ширина каждой: одно длинное слово без пробелов
  // («Рестораннаберезинойулице») wrapWords вернёт единственной строкой любой ширины, и без
  // этой проверки оно уехало бы за край макета в полном кегле.
  for (let s = size; s >= minSize; s -= 0.5) {
    const lines = wrapWords(clean, { font, size: s, maxWidthMm });
    const fits = lines.every((line) => measureTextMm(line, { font, size: s }) <= maxWidthMm);
    if (lines.length <= maxLines && fits) return { lines, size: s };
  }

  // 3. И так не влезло — обрезаем многоточием. Каждую строку, а не только последнюю:
  // переполнить ширину может любая из них (см. случай с неразрывным словом выше).
  const lines = wrapWords(clean, { font, size: minSize, maxWidthMm }).slice(0, maxLines);
  const truncated = lines.map((line, i) => {
    const isLast = i === lines.length - 1;
    const withEllipsis = isLast ? `${line}…` : line;
    return measureTextMm(withEllipsis, { font, size: minSize }) > maxWidthMm
      ? truncateToWidth(withEllipsis, { font, size: minSize, maxWidthMm })
      : withEllipsis;
  });
  return { lines: truncated, size: minSize };
}

function wrapWords(text, { font, size, maxWidthMm }) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureTextMm(candidate, { font, size }) <= maxWidthMm || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function truncateToWidth(text, { font, size, maxWidthMm }) {
  let result = String(text);
  while (result.length > 1 && measureTextMm(result, { font, size }) > maxWidthMm) {
    result = result.slice(0, -2) + '…';
  }
  return result;
}

// Метки реза — четыре уголка за пределами линии обреза, чтобы типография видела, где резать.
// Возвращает отрезки в мм относительно левого верхнего угла ПОЛОТНА (то есть с учётом вылетов).
function cropMarkLines(widthMm, heightMm, bleedMm = BLEED_MM) {
  const len = bleedMm; // длина метки равна вылету — так они не заезжают в сам макет
  const b = bleedMm;
  const right = b + widthMm;
  const bottom = b + heightMm;
  return [
    // левый верхний
    { x1: 0, y1: b, x2: len, y2: b }, { x1: b, y1: 0, x2: b, y2: len },
    // правый верхний
    { x1: right, y1: b, x2: right + len, y2: b }, { x1: right, y1: 0, x2: right, y2: len },
    // левый нижний
    { x1: 0, y1: bottom, x2: len, y2: bottom }, { x1: b, y1: bottom, x2: b, y2: bottom + len },
    // правый нижний
    { x1: right, y1: bottom, x2: right + len, y2: bottom }, { x1: right, y1: bottom, x2: right, y2: bottom + len },
  ];
}

module.exports = {
  MM, mm, BLEED_MM, MIN_QR_MM, QUIET_ZONE_MODULES,
  FONT_FILES, loadFont, measureTextMm, fitText, wrapWords, truncateToWidth, cropMarkLines,
};
