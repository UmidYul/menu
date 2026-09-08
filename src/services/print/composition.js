const { fitText } = require('./geometry');
const { planQr, drawQr } = require('./qr');
const { sanitizeForFont } = require('./text');
const { COLORS, QR_DARK, QR_LIGHT } = require('./theme');

// Общая «карточка с QR» — визуальная схема, одинаковая у всех макетов: заливной фирменный фон,
// на нём светлая карточка с кодом, над ней название заведения, под ней призыв на выбранных
// языках. Разные макеты отличаются только размерами и тем, что из блоков показано.

// Заливка фона С УЧЁТОМ ВЫЛЕТОВ: фон обязан заходить за линию реза, иначе после подрезки
// по краю появится белая полоска.
function fillBleedBackground(canvas, { widthMm, heightMm, bleedMm, color = COLORS.primary }) {
  canvas.rect(0, 0, widthMm + bleedMm * 2, heightMm + bleedMm * 2, color);
}

// Светлая карточка под QR со скруглением — тот же радиус, что у карточек в вебе.
function drawQrCard(canvas, { x, y, sizeMm, url, ecc = 'M', radiusMm = 3, padded = true }) {
  const plan = planQr(url, sizeMm, { ecc });
  if (padded) canvas.roundedRect(x, y, sizeMm, sizeMm, radiusMm, QR_LIGHT);
  drawQr(canvas, plan, x, y, { dark: QR_DARK, light: null });
  return plan;
}

// Название заведения: автоподбор кегля -> перенос на две строки -> многоточие (edge case промта).
function drawVenueName(canvas, { name, x, y, widthMm, size, minSize, color = COLORS.paper, font = 'serif' }) {
  const safe = sanitizeForFont(name, font);
  const fitted = fitText(safe, { font, size, minSize: minSize || size * 0.55, maxWidthMm: widthMm, maxLines: 2 });
  return canvas.text(fitted.lines, {
    x, y, width: widthMm, size: fitted.size, font, color, align: 'center', lineHeightFactor: 1.15,
  });
}

// Призыв «отсканируйте — откроется меню» на выбранных языках. Промт: если выбрано два языка —
// текст в две строки (по строке на язык), поэтому строки не склеиваются.
function drawCallToAction(canvas, { lines, x, y, widthMm, size, color = COLORS.paper, font = 'sans' }) {
  const safeLines = lines.map((line) => sanitizeForFont(line, font));
  return canvas.text(safeLines, {
    x, y, width: widthMm, size, font, color, align: 'center', lineHeightFactor: 1.4,
  });
}

// Контакты и часы работы (необязательный блок листа A4).
function drawContacts(canvas, { venue, x, y, widthMm, size, color = COLORS.paper, font = 'sans' }) {
  const rows = [venue.phone, venue.address, venue.working_hours]
    .filter(Boolean)
    .map((row) => sanitizeForFont(String(row).replace(/\s*\n\s*/g, ' · '), font));
  if (rows.length === 0) return 0;
  return canvas.text(rows, { x, y, width: widthMm, size, font, color, align: 'center', lineHeightFactor: 1.5 });
}

// Домен сервиса в самом низу макета (site_settings.print_domain). Если домен не задан —
// не рисуем НИЧЕГО и не резервируем место: пока адрес не куплен, пустая строка внизу выглядела
// бы как дефект вёрстки.
function drawServiceDomain(canvas, { domain, x, y, widthMm, size, color = COLORS.paper, font = 'sans' }) {
  if (!domain) return 0;
  return canvas.text([sanitizeForFont(domain, font)], {
    x, y, width: widthMm, size, font, color, align: 'center', lineHeightFactor: 1,
  });
}

module.exports = {
  fillBleedBackground, drawQrCard, drawVenueName, drawCallToAction, drawContacts, drawServiceDomain, COLORS,
};
