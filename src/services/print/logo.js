const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');

// pdfkit умеет встраивать только PNG и JPEG, а логотипы заведений лежат в webp (их так
// сохраняет photoService через sharp). Поэтому перед вставкой в PDF логотип перегоняется
// в PNG тем же sharp — новая зависимость для этого не нужна.
//
// Берутся ТОЛЬКО локальные файлы из /uploads. Внешние http(s)-ссылки (такие остались в
// демо-данных) намеренно игнорируются: ходить с сервера по произвольному URL из базы ради
// картинки — лишний сетевой запрос в отрисовке PDF и лишняя поверхность для SSRF.
// Макеты рассчитаны на отсутствие логотипа и перестраиваются без пустого места (edge case промта).
const UPLOADS_ROOT = path.join(__dirname, '../../../public/uploads');
const MAX_SIDE_PX = 600; // логотип печатается размером ~18-28 мм, больше просто раздует PDF

async function loadLogoPng(logoUrl) {
  if (!logoUrl || typeof logoUrl !== 'string') return null;
  if (!logoUrl.startsWith('/uploads/')) return null;

  // Защита от выхода за пределы каталога загрузок: имя файла берём как есть и проверяем,
  // что итоговый путь всё ещё внутри UPLOADS_ROOT.
  const relative = logoUrl.replace(/^\/uploads\//, '');
  const filePath = path.resolve(UPLOADS_ROOT, relative);
  if (!filePath.startsWith(path.resolve(UPLOADS_ROOT))) return null;

  try {
    await fs.access(filePath);
    return await sharp(filePath)
      .resize(MAX_SIDE_PX, MAX_SIDE_PX, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (err) {
    // Файла нет или он битый — печатаем без логотипа, а не роняем генерацию макета.
    console.error('print: не удалось подготовить логотип для PDF', err.message);
    return null;
  }
}

module.exports = { loadLogoPng };
