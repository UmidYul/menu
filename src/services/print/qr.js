const QRCode = require('qrcode');
const { MIN_QR_MM, QUIET_ZONE_MODULES } = require('./geometry');

// Промт 3.4: QR вставляется ВЕКТОРНО, чтобы качество не зависело от размера печати.
// SVG от библиотеки qrcode здесь не используется намеренно: она рисует код горизонтальными
// штрихами через stroke, и парсинг такого пути ради pdfkit хрупок. Матрица модулей — то же
// самое, но без посредника: каждый тёмный модуль становится прямоугольником, и это одинаково
// работает и в PDF, и в SVG-предпросмотре.
function buildMatrix(text, { ecc = 'M' } = {}) {
  const qr = QRCode.create(String(text), { errorCorrectionLevel: ecc });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const dark = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (data[row * size + col]) dark.push({ row, col });
    }
  }
  return { size, dark };
}

// Считает геометрию кода в миллиметрах и НЕ ДАЁТ нарушить два печатных правила промта:
// физический размер кода минимум 25 мм и тихая зона минимум 4 модуля вокруг.
//
// boxMm — сколько места отведено под код ВМЕСТЕ с тихой зоной. Возвращает размер самого кода
// и отступ, на который его нужно сместить внутрь бокса.
function planQr(text, boxMm, { ecc = 'M', quietModules = QUIET_ZONE_MODULES } = {}) {
  const matrix = buildMatrix(text, { ecc });
  // Тихая зона занимает место в том же боксе: код + 2*quiet модулей по каждой оси.
  const totalModules = matrix.size + quietModules * 2;
  const moduleMm = boxMm / totalModules;
  const codeMm = moduleMm * matrix.size;

  if (codeMm < MIN_QR_MM) {
    // Осознанно бросаем, а не молча рисуем нечитаемый код: настройки не должны позволять
    // сделать QR меньше 25 мм (промт 3.4, раздел «Качество печати»).
    const err = new Error(`QR ${codeMm.toFixed(1)} мм меньше минимальных ${MIN_QR_MM} мм`);
    err.code = 'QR_TOO_SMALL';
    throw err;
  }

  return {
    matrix,
    moduleMm,
    codeMm,
    quietMm: moduleMm * quietModules,
    modules: matrix.size,
  };
}

// Рисует код на любом «холсте» (интерфейс canvas.js) — общий код для PDF и SVG.
// x/y — левый верхний угол БОКСА (то есть вместе с тихой зоной).
function drawQr(canvas, plan, x, y, { dark = '#27251f', light = null } = {}) {
  if (light) {
    const box = plan.codeMm + plan.quietMm * 2;
    canvas.rect(x, y, box, box, light);
  }
  const originX = x + plan.quietMm;
  const originY = y + plan.quietMm;
  // Микро-перекрытие 2% модуля убирает белые швы между соседними модулями при растеризации
  // просмотрщиком; на вектор и на читаемость кода это не влияет.
  const overlap = plan.moduleMm * 0.02;
  for (const { row, col } of plan.matrix.dark) {
    canvas.rect(
      originX + col * plan.moduleMm,
      originY + row * plan.moduleMm,
      plan.moduleMm + overlap,
      plan.moduleMm + overlap,
      dark
    );
  }
}

module.exports = { buildMatrix, planQr, drawQr };
