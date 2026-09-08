const { mm, FONT_FILES, fitText, measureTextMm, cropMarkLines } = require('./geometry');

// Один интерфейс рисования — две реализации. Макеты (layouts/*.js) не знают, во что их рисуют:
// в PDF на скачивание или в SVG для предпросмотра в модалке. Это единственный способ выполнить
// требование промта «предпросмотр рендерится ТЕМ ЖЕ кодом» без растеризатора PDF, которого
// в системе нет, и без headless-браузера, который промт прямо запрещает.
//
// Все координаты и размеры — в миллиметрах. Кегль — в пунктах (как в вебе).

class PdfCanvas {
  constructor(doc) {
    this.doc = doc;
    this.kind = 'pdf';
  }

  rect(x, y, w, h, color) {
    this.doc.save().fillColor(color).rect(mm(x), mm(y), mm(w), mm(h)).fill().restore();
  }

  roundedRect(x, y, w, h, radius, color) {
    this.doc.save().fillColor(color).roundedRect(mm(x), mm(y), mm(w), mm(h), mm(radius)).fill().restore();
  }

  circle(cx, cy, r, color) {
    this.doc.save().fillColor(color).circle(mm(cx), mm(cy), mm(r)).fill().restore();
  }

  line(x1, y1, x2, y2, color, widthMm = 0.15) {
    this.doc.save().strokeColor(color).lineWidth(mm(widthMm)).moveTo(mm(x1), mm(y1)).lineTo(mm(x2), mm(y2)).stroke().restore();
  }

  circleOutline(cx, cy, r, color, widthMm = 0.15) {
    this.doc.save().strokeColor(color).lineWidth(mm(widthMm)).circle(mm(cx), mm(cy), mm(r)).stroke().restore();
  }

  // Возвращает высоту занятого блока в мм — макеты складывают из этого вертикальный поток.
  text(lines, { x, y, width, size, font = 'sans', color = '#27251f', align = 'center', lineHeightFactor = 1.25 }) {
    const rows = Array.isArray(lines) ? lines : [lines];
    const lineHeightMm = (size * lineHeightFactor) / (72 / 25.4);
    this.doc.save().font(FONT_FILES[font]).fontSize(size).fillColor(color);
    rows.forEach((row, i) => {
      // lineBreak:false — переносы уже сделаны fitText через fontkit, второй раз ломать строку
      // средствами pdfkit нельзя, иначе предпросмотр и PDF разъедутся.
      this.doc.text(row, mm(x), mm(y + i * lineHeightMm), { width: mm(width), align, lineBreak: false });
    });
    this.doc.restore();
    return rows.length * lineHeightMm;
  }

  image(buffer, x, y, w, h) {
    // fit сохраняет пропорции логотипа и вписывает его в отведённый бокс.
    this.doc.image(buffer, mm(x), mm(y), { fit: [mm(w), mm(h)], align: 'center', valign: 'center' });
  }

  // Сдвиг начала координат — макеты считают всё от обрезного формата, а на полотне ещё есть
  // вылеты; смещение делается здесь, чтобы в самих макетах о вылетах не думать.
  translated(dx, dy, drawFn) {
    this.doc.save().translate(mm(dx), mm(dy));
    drawFn();
    this.doc.restore();
  }

  // Разворот блока на 180° вокруг его центра — нужен верхней половине тейбл-тента, чтобы
  // после сгиба обе стороны «палатки» читались правильно.
  rotated180(box, drawFn) {
    const cx = mm(box.x + box.w / 2);
    const cy = mm(box.y + box.h / 2);
    this.doc.save().rotate(180, { origin: [cx, cy] });
    drawFn();
    this.doc.restore();
  }
}

class SvgCanvas {
  constructor(widthMm, heightMm) {
    this.kind = 'svg';
    this.widthMm = widthMm;
    this.heightMm = heightMm;
    this.parts = [];
  }

  static escape(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  rect(x, y, w, h, color) {
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`);
  }

  roundedRect(x, y, w, h, radius, color) {
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${color}"/>`);
  }

  circle(cx, cy, r, color) {
    this.parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
  }

  line(x1, y1, x2, y2, color, widthMm = 0.15) {
    this.parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${widthMm}"/>`);
  }

  circleOutline(cx, cy, r, color, widthMm = 0.15) {
    this.parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${widthMm}"/>`);
  }

  text(lines, { x, y, width, size, font = 'sans', color = '#27251f', align = 'center', lineHeightFactor = 1.25 }) {
    const rows = Array.isArray(lines) ? lines : [lines];
    const sizeMm = size / (72 / 25.4);
    const lineHeightMm = sizeMm * lineHeightFactor;
    // Предпросмотр показывается в браузере, где те же шрифты уже подключены через fonts.css,
    // поэтому семейство задаётся по имени, а не файлом.
    const family = font === 'serif' ? "'Playfair Display', serif" : "'Manrope', sans-serif";
    const anchor = align === 'center' ? 'middle' : (align === 'right' ? 'end' : 'start');
    const anchorX = align === 'center' ? x + width / 2 : (align === 'right' ? x + width : x);
    rows.forEach((row, i) => {
      // dominant-baseline не поддержан одинаково везде; смещаем на ~0.8 кегля вручную, чтобы
      // визуально совпасть с pdfkit, который позиционирует текст по верхней границе строки.
      const baselineY = y + i * lineHeightMm + sizeMm * 0.8;
      this.parts.push(
        `<text x="${anchorX}" y="${baselineY}" font-family="${family}" font-size="${sizeMm}" fill="${color}" text-anchor="${anchor}">${SvgCanvas.escape(row)}</text>`
      );
    });
    return rows.length * lineHeightMm;
  }

  image(buffer, x, y, w, h) {
    const base64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : '';
    if (!base64) return;
    this.parts.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${base64}"/>`);
  }

  translated(dx, dy, drawFn) {
    const from = this.parts.length;
    drawFn();
    const inner = this.parts.splice(from).join('');
    this.parts.push(`<g transform="translate(${dx} ${dy})">${inner}</g>`);
  }

  // То же, что и в PDF: всё, что нарисовано внутри колбэка, оборачивается в один
  // повёрнутый <g>. Для этого запоминаем позицию в списке и вырезаем добавленное.
  rotated180(box, drawFn) {
    const from = this.parts.length;
    drawFn();
    const inner = this.parts.splice(from).join('');
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    this.parts.push(`<g transform="rotate(180 ${cx} ${cy})">${inner}</g>`);
  }

  toString() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.widthMm} ${this.heightMm}" width="100%">`
      + this.parts.join('') + '</svg>';
  }
}

// Метки реза одинаковы для всех макетов — рисуем через тот же интерфейс.
function drawCropMarks(canvas, widthMm, heightMm, bleedMm, color = '#27251f') {
  for (const l of cropMarkLines(widthMm, heightMm, bleedMm)) {
    canvas.line(l.x1, l.y1, l.x2, l.y2, color, 0.12);
  }
}

module.exports = { PdfCanvas, SvgCanvas, drawCropMarks, fitText, measureTextMm };
