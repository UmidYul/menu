const { BLEED_MM, cropMarkLines } = require('./geometry');
const { drawCropMarks } = require('./canvas');
const { fillBleedBackground, drawQrCard, drawVenueName, drawCallToAction, drawContacts, drawServiceDomain } = require('./composition');
const { COLORS } = require('./theme');

// Промт 3.4, шесть макетов. Каждый описывается размером ОБРЕЗНОГО формата в мм, нужны ли
// вылеты/метки реза, и функцией draw(canvas, ctx), которая рисует ОДНУ страницу.
// ctx: { venue, url, urlFor(table), tables, ctaLines, showLogo, showContacts, logo }
//
// Внутри draw координаты считаются от левого верхнего угла ОБРЕЗНОГО формата, а сдвиг на вылет
// делает renderer — так в макетах не приходится держать в голове BLEED_MM.

// --- 1. Тейбл-тент ---------------------------------------------------------------------
// Лист A5 (148x210) со сгибом посередине: верхняя половина повёрнута на 180°, поэтому
// после сгиба получается стоящая на столе «палатка» A6, читаемая с обеих сторон — это и есть
// «A6, двусторонний, со сгибом» из промта, только одним листом, а не двумя деталями на клей.
function drawTentPanel(canvas, ctx, { originY, panelH, panelW }) {
  const pad = 10;
  const inner = panelW - pad * 2;
  let y = originY + 12;

  if (ctx.showLogo && ctx.logo) {
    canvas.image(ctx.logo, originY === 0 ? pad + inner / 2 - 9 : pad + inner / 2 - 9, y, 18, 18);
    y += 22;
  }

  y += drawVenueName(canvas, { name: ctx.venue.name, x: pad, y, widthMm: inner, size: 22, minSize: 12 });
  y += 4;

  const qrSize = Math.min(inner - 16, panelH - (y - originY) - 26);
  const qrX = pad + (inner - qrSize) / 2;
  drawQrCard(canvas, { x: qrX, y, sizeMm: qrSize, url: ctx.url, ecc: ctx.ecc });
  y += qrSize + 6;

  drawCallToAction(canvas, { lines: ctx.ctaLines, x: pad, y, widthMm: inner, size: 9 });

  // Домен — прижат к низу панели, а не к потоку: так он стоит на одном месте независимо от
  // того, сколько строк занял призыв и есть ли логотип.
  drawServiceDomain(canvas, { domain: ctx.domain, x: pad, y: originY + panelH - 9, widthMm: inner, size: 7.5 });
}

const tentA6 = {
  id: 'tent-a6',
  widthMm: 148,
  heightMm: 210,
  bleed: true,
  cropMarks: true,
  perTable: false,
  draw(canvas, ctx) {
    const { widthMm: W, heightMm: H } = tentA6;
    fillBleedBackground(canvas, { widthMm: W, heightMm: H, bleedMm: BLEED_MM });
    const half = H / 2;

    // Нижняя половина — как есть; верхняя рисуется отдельным вызовом с разворотом на 180°,
    // который делает рендерер (в SVG-предпросмотре разворот показывается как есть — это
    // корректно: именно так лист и выглядит до сгиба).
    drawTentPanel(canvas, ctx, { originY: half, panelH: half, panelW: W });
    canvas.rotated180({ x: 0, y: 0, w: W, h: half }, () => {
      drawTentPanel(canvas, ctx, { originY: 0, panelH: half, panelW: W });
    });

    // Линия сгиба — пунктир по центру.
    for (let x = 6; x < W - 6; x += 4) canvas.line(x, half, x + 2, half, COLORS.paper, 0.2);
  },
};

// --- 2. Круглая наклейка 80 мм ----------------------------------------------------------
const stickerRound = {
  id: 'sticker-round-80',
  widthMm: 80,
  heightMm: 80,
  bleed: true,
  cropMarks: false, // круглая вырубка: метки реза бессмысленны, вместо них контур реза
  perTable: false,
  draw(canvas, ctx) {
    const S = 80;
    // Круглая вырубка: фирменный цвет заливает только сам круг, поле вокруг остаётся бумагой —
    // иначе на предпросмотре и на печати наклейка выглядит квадратной. Круг рисуется с запасом
    // на вылет (радиус +3 мм), чтобы неточность вырубки не оголила белый край.
    canvas.rect(-BLEED_MM, -BLEED_MM, S + BLEED_MM * 2, S + BLEED_MM * 2, COLORS.paper);
    canvas.circle(S / 2, S / 2, S / 2 + BLEED_MM, COLORS.primary);
    // Тонкий контур по линии реза — ориентир для вырубного штампа.
    canvas.circleOutline(S / 2, S / 2, S / 2, COLORS.paper, 0.2);

    const qrSize = 46;
    drawQrCard(canvas, { x: (S - qrSize) / 2, y: 12, sizeMm: qrSize, url: ctx.url, ecc: ctx.ecc });
    drawCallToAction(canvas, { lines: ctx.ctaLines.slice(0, 2), x: 8, y: 60, widthMm: S - 16, size: 7 });
    drawServiceDomain(canvas, { domain: ctx.domain, x: 8, y: 70, widthMm: S - 16, size: 6 });
  },
};

// --- 3. Прямоугольная наклейка 90x50 (визитка) -------------------------------------------
const stickerCard = {
  id: 'sticker-card-90x50',
  widthMm: 90,
  heightMm: 50,
  bleed: true,
  cropMarks: true,
  perTable: false,
  draw(canvas, ctx) {
    const W = 90; const H = 50;
    fillBleedBackground(canvas, { widthMm: W, heightMm: H, bleedMm: BLEED_MM });

    // QR слева, текст справа (промт).
    const qrSize = 38;
    drawQrCard(canvas, { x: 6, y: (H - qrSize) / 2, sizeMm: qrSize, url: ctx.url, ecc: ctx.ecc });

    const textX = 6 + qrSize + 6;
    const textW = W - textX - 6;
    let y = 12;
    y += drawVenueName(canvas, { name: ctx.venue.name, x: textX, y, widthMm: textW, size: 13, minSize: 8 });
    y += 2;
    drawCallToAction(canvas, { lines: ctx.ctaLines.slice(0, 2), x: textX, y, widthMm: textW, size: 6.5 });
    drawServiceDomain(canvas, { domain: ctx.domain, x: textX, y: H - 9, widthMm: textW, size: 6 });
  },
};

// --- 4. Лист A4 на дверь/стену -----------------------------------------------------------
const posterA4 = {
  id: 'poster-a4',
  widthMm: 210,
  heightMm: 297,
  bleed: true,
  cropMarks: false, // печатается дома на обычном A4, резать нечего
  perTable: false,
  draw(canvas, ctx) {
    const W = 210; const H = 297;
    fillBleedBackground(canvas, { widthMm: W, heightMm: H, bleedMm: BLEED_MM });

    let y = 26;
    if (ctx.showLogo && ctx.logo) {
      canvas.image(ctx.logo, W / 2 - 14, y, 28, 28);
      y += 34;
    }
    y += drawVenueName(canvas, { name: ctx.venue.name, x: 20, y, widthMm: W - 40, size: 38, minSize: 20 });
    y += 8;

    const qrSize = 110;
    drawQrCard(canvas, { x: (W - qrSize) / 2, y, sizeMm: qrSize, url: ctx.url, ecc: ctx.ecc, radiusMm: 5 });
    y += qrSize + 10;

    y += drawCallToAction(canvas, { lines: ctx.ctaLines, x: 20, y, widthMm: W - 40, size: 13 });

    if (ctx.showContacts) {
      y += 6;
      drawContacts(canvas, { venue: ctx.venue, x: 20, y, widthMm: W - 40, size: 9 });
    }

    drawServiceDomain(canvas, { domain: ctx.domain, x: 20, y: H - 18, widthMm: W - 40, size: 11 });
  },
};

// --- 5. Лист A4 с сеткой одинаковых наклеек под резку ------------------------------------
// 12 штук: 3 колонки x 4 ряда, размер ячейки 60x65 мм, с метками реза между ячейками.
const sheetStickersA4 = {
  id: 'sheet-stickers-a4',
  widthMm: 210,
  heightMm: 297,
  bleed: false, // режется по меткам из цельного листа, вылеты не нужны
  cropMarks: false,
  perTable: false,
  grid: { cols: 3, rows: 4, cellW: 60, cellH: 65, marginX: 15, marginY: 18 },
  draw(canvas, ctx) {
    const { cols, rows, cellW, cellH, marginX, marginY } = sheetStickersA4.grid;
    canvas.rect(0, 0, 210, 297, COLORS.paper);

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const x = marginX + c * cellW;
        const y = marginY + r * cellH;
        drawGridCell(canvas, ctx, { x, y, w: cellW, h: cellH, url: ctx.url, caption: null });
      }
    }
    drawGridCutMarks(canvas, sheetStickersA4.grid, 210, 297);
  },
};

// --- 6. Лист A4 «QR по столам» -----------------------------------------------------------
// Та же сетка, но у каждой ячейки свой QR с токеном стола и подписанным номером.
const sheetTablesA4 = {
  id: 'sheet-tables-a4',
  widthMm: 210,
  heightMm: 297,
  bleed: false,
  cropMarks: false,
  perTable: true,
  perPage: 12,
  grid: sheetStickersA4.grid,
  draw(canvas, ctx) {
    const { cols, rows, cellW, cellH, marginX, marginY } = sheetTablesA4.grid;
    canvas.rect(0, 0, 210, 297, COLORS.paper);

    ctx.pageTables.forEach((table, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      if (r >= rows) return;
      drawGridCell(canvas, ctx, {
        x: marginX + c * cellW,
        y: marginY + r * cellH,
        w: cellW,
        h: cellH,
        url: ctx.urlFor(table),
        caption: ctx.tableCaption(table),
      });
    });
    drawGridCutMarks(canvas, sheetTablesA4.grid, 210, 297);
  },
};

// Одна ячейка сетки: фирменная плашка, светлая карточка с QR, подпись (номер стола) под ним.
function drawGridCell(canvas, ctx, { x, y, w, h, url, caption }) {
  const pad = 3;
  canvas.roundedRect(x + pad, y + pad, w - pad * 2, h - pad * 2, 3, COLORS.primary);

  const inner = w - pad * 2;
  const qrSize = Math.min(inner - 8, 40);
  const qrX = x + pad + (inner - qrSize) / 2;
  drawQrCard(canvas, { x: qrX, y: y + pad + 4, sizeMm: qrSize, url, ecc: ctx.ecc, radiusMm: 2 });

  let textY = y + pad + 4 + qrSize + 2;
  if (caption) {
    textY += canvas.text([caption], {
      x: x + pad, y: textY, width: inner, size: 10, font: 'serif', color: COLORS.paper, align: 'center',
    });
  }
  textY += canvas.text([ctx.ctaLines[0]], {
    x: x + pad, y: textY, width: inner, size: 5.5, font: 'sans', color: COLORS.paper, align: 'center',
  });
  drawServiceDomain(canvas, { domain: ctx.domain, x: x + pad, y: textY + 0.5, widthMm: inner, size: 5 });
}

// Метки реза по краям сетки — короткие штрихи на полях листа напротив каждой линии реза.
function drawGridCutMarks(canvas, grid, pageW, pageH) {
  const { cols, rows, cellW, cellH, marginX, marginY } = grid;
  const color = '#b8b3a9';
  for (let c = 0; c <= cols; c += 1) {
    const x = marginX + c * cellW;
    canvas.line(x, marginY - 6, x, marginY - 2, color, 0.12);
    canvas.line(x, marginY + rows * cellH + 2, x, marginY + rows * cellH + 6, color, 0.12);
  }
  for (let r = 0; r <= rows; r += 1) {
    const y = marginY + r * cellH;
    canvas.line(marginX - 6, y, marginX - 2, y, color, 0.12);
    canvas.line(marginX + cols * cellW + 2, y, marginX + cols * cellW + 6, y, color, 0.12);
  }
}

const LAYOUTS = [tentA6, stickerRound, stickerCard, posterA4, sheetStickersA4, sheetTablesA4];
const LAYOUTS_BY_ID = new Map(LAYOUTS.map((l) => [l.id, l]));

module.exports = { LAYOUTS, LAYOUTS_BY_ID, drawCropMarks, cropMarkLines };
