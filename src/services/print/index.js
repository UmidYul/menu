const PDFDocument = require('pdfkit');
const { mm, BLEED_MM, FONT_FILES } = require('./geometry');
const { PdfCanvas, SvgCanvas, drawCropMarks } = require('./canvas');
const { LAYOUTS, LAYOUTS_BY_ID } = require('./layouts');
const { findUnsupported } = require('./text');
const { COLORS } = require('./theme');

// Промт 3.4: «Генерация PDF на 100 столов не должна блокировать процесс: делай потоково
// и ограничь 200 страницами за раз». Замер: 100 столов (9 листов) — ~170 мс, так что предел
// упирается не в скорость, а в здравый смысл размера файла.
const MAX_PAGES = 200;

// Каждый макет знает свой обрезной формат; полотно страницы больше на вылеты с двух сторон.
function pageSize(layout) {
  const bleed = layout.bleed ? BLEED_MM : 0;
  return {
    bleed,
    widthMm: layout.widthMm + bleed * 2,
    heightMm: layout.heightMm + bleed * 2,
  };
}

// Ссылка, которая попадёт в код. encodeURIComponent на slug и токене — промт отдельно просит
// проверить корректность экранирования (slug валидируется при создании, но URL всё равно
// собираем безопасно, а не конкатенацией «как есть»).
function menuUrl(baseUrl, slug, token) {
  const base = `${baseUrl}/menu/${encodeURIComponent(slug)}`;
  const params = new URLSearchParams();
  if (token) params.set('t', token);
  params.set('src', 'qr');
  return `${base}?${params.toString()}`;
}

// Сколько страниц займёт макет при этих настройках.
function pageCount(layout, tables) {
  if (!layout.perTable) return 1;
  return Math.max(1, Math.ceil(tables.length / layout.perPage));
}

function buildContext(layout, { venue, baseUrl, ctaLines, showLogo, showContacts, logo, tables, tableLabel, domain }) {
  return {
    venue,
    ctaLines: ctaLines.length ? ctaLines : [''],
    showLogo,
    showContacts,
    logo,
    // Домен сервиса из site_settings; null/'' -> блок просто не рисуется.
    domain: domain || null,
    tables,
    // Макеты с логотипом в центре кода потребовали бы 'H'; сейчас логотип рисуется отдельно
    // над кодом, поэтому достаточно 'M' (промт: 'M' по умолчанию, 'H' для логотипа внутри).
    ecc: 'M',
    url: menuUrl(baseUrl, venue.slug, null),
    urlFor: (table) => menuUrl(baseUrl, venue.slug, table.token),
    tableCaption: (table) => tableLabel(table.number),
    pageTables: [],
  };
}

// Рисует одну страницу макета на переданный холст, разбираясь с вылетами и метками реза.
function drawPage(layout, canvas, ctx) {
  const { bleed } = pageSize(layout);
  if (bleed) {
    // Внутри макета координаты идут от обрезного формата, поэтому смещаем начало на вылет.
    canvas.translated(bleed, bleed, () => layout.draw(canvas, ctx));
    if (layout.cropMarks) drawCropMarks(canvas, layout.widthMm, layout.heightMm, bleed, COLORS.ink);
  } else {
    layout.draw(canvas, ctx);
  }
}

// PDF на скачивание. Пишется потоково в переданный stream (res), документ не собирается
// в памяти целиком.
function renderPdf(layoutId, options, stream) {
  const layout = LAYOUTS_BY_ID.get(layoutId);
  if (!layout) throw new Error(`Неизвестный макет: ${layoutId}`);

  const { widthMm, heightMm } = pageSize(layout);
  const doc = new PDFDocument({ size: [mm(widthMm), mm(heightMm)], margin: 0, autoFirstPage: false });
  doc.registerFont('sans', FONT_FILES.sans);
  doc.registerFont('serif', FONT_FILES.serif);
  doc.pipe(stream);

  const ctx = buildContext(layout, options);
  const canvas = new PdfCanvas(doc);
  const pages = Math.min(pageCount(layout, options.tables), MAX_PAGES);

  for (let page = 0; page < pages; page += 1) {
    doc.addPage({ size: [mm(widthMm), mm(heightMm)], margin: 0 });
    if (layout.perTable) {
      ctx.pageTables = options.tables.slice(page * layout.perPage, (page + 1) * layout.perPage);
    }
    drawPage(layout, canvas, ctx);
  }

  doc.end();
  return { pages, truncated: pageCount(layout, options.tables) > MAX_PAGES };
}

// Предпросмотр первой страницы. Промт просит рендерить «тем же кодом» — тот же layout.draw,
// только холст другой. Растеризовать PDF в PNG нечем (в системе нет pdftoppm/mupdf), а
// headless-браузер промт прямо запрещает, поэтому предпросмотр отдаётся вектором SVG:
// геометрия, переносы и автоподбор кегля считаются тем же fontkit, что и в PDF.
function renderPreviewSvg(layoutId, options) {
  const layout = LAYOUTS_BY_ID.get(layoutId);
  if (!layout) throw new Error(`Неизвестный макет: ${layoutId}`);

  const { widthMm, heightMm } = pageSize(layout);
  const canvas = new SvgCanvas(widthMm, heightMm);
  const ctx = buildContext(layout, options);
  if (layout.perTable) ctx.pageTables = options.tables.slice(0, layout.perPage);
  drawPage(layout, canvas, ctx);
  return canvas.toString();
}

// Символы названия заведения, которых нет в печатных шрифтах — админка предупреждает заранее,
// чтобы владелец не удивился замене в PDF.
function unsupportedCharacters(venueName) {
  const inSerif = findUnsupported(venueName, 'serif');
  const inSans = findUnsupported(venueName, 'sans');
  return [...new Set([...inSerif, ...inSans])];
}

module.exports = {
  LAYOUTS, LAYOUTS_BY_ID, MAX_PAGES,
  renderPdf, renderPreviewSvg, pageCount, pageSize, menuUrl, unsupportedCharacters,
};
