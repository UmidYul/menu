const { loadFont } = require('./geometry');

// Промт 3.4: «Проверь, что кириллица и латиница с диакритикой рендерятся корректно».
// Проверка вариативных TTF из google/fonts показала конкретные дыры:
//   Manrope  — нет ʻ (U+02BB, апостроф узбекской латиницы: oʻzbekcha, gʻalati) и Қ Ғ Ҳ;
//   Playfair — нет Ҳ ҳ и ₽.
// Русская кириллица, латиница и диакритика (Ćüñö) есть в обоих. Названия заведений и блюд
// вводит владелец, поэтому в макет может прилететь что угодно — без подготовки в PDF окажется
// пустой прямоугольник .notdef, что выглядит как поломка вёрстки.

// Типографские апострофы и кавычки приводим к тем, что в шрифтах есть. Для узбекской латиницы
// это важнее всего: ʻ встречается в каждом втором слове, а выглядит после замены неотличимо.
const NORMALIZE = new Map(Object.entries({
  'ʻ': "'", 'ʼ': "'", 'ʹ': "'", '‘': "'", '’': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '″': '"',
  '–': '-', '—': '—', ' ': ' ', ' ': ' ', ' ': ' ',
}));

// Узбекская кириллица: в проекте языки меню — ru/uz/en, где uz это латиница, так что штатно
// эти буквы не встречаются. Но если владелец введёт название на узбекской кириллице, буква
// не должна превратиться в пустой прямоугольник — подставляем ближайший похожий глиф.
const CYRILLIC_FALLBACK = new Map(Object.entries({
  'Қ': 'К', 'қ': 'к', 'Ғ': 'Г', 'ғ': 'г', 'Ҳ': 'Х', 'ҳ': 'х',
  'Ў': 'У', 'ў': 'у', 'Ҷ': 'Ч', 'ҷ': 'ч', 'Ҙ': 'З', 'ҙ': 'з',
}));

function normalize(text) {
  return [...String(text || '')].map((ch) => NORMALIZE.get(ch) || ch).join('');
}

// Финальная страховка: всё, чего в конкретном шрифте всё равно нет, заменяем на fallback,
// а если и его нет — выбрасываем символ совсем. Пустой прямоугольник в печатном макете хуже,
// чем отсутствующая буква.
function sanitizeForFont(text, fontKey) {
  const font = loadFont(fontKey);
  const has = (ch) => font.glyphForCodePoint(ch.codePointAt(0)).id !== 0;

  return [...normalize(text)].map((ch) => {
    if (has(ch)) return ch;
    const fallback = CYRILLIC_FALLBACK.get(ch);
    if (fallback && has(fallback)) return fallback;
    return '';
  }).join('');
}

// Какие символы пришлось заменить — админка показывает это предупреждением, чтобы владелец
// не удивился, увидев в PDF не то, что вводил.
function findUnsupported(text, fontKey) {
  const font = loadFont(fontKey);
  const missing = new Set();
  for (const ch of normalize(text)) {
    if (ch.trim() && font.glyphForCodePoint(ch.codePointAt(0)).id === 0) missing.add(ch);
  }
  return [...missing];
}

module.exports = { normalize, sanitizeForFont, findUnsupported };
