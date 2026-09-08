const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');

const THUMB_WIDTH = 200;
const FULL_WIDTH = 800;

// Общее ядро для saveItemPhoto/saveReceiptPhoto — ничего в самой обработке не зависит от того,
// фото это позиции меню или скриншот чека, только вызывающий код и назначение файла разные.
async function saveVenueImage(venueId, buffer) {
  const dir = path.join(UPLOADS_ROOT, String(venueId));
  await fs.mkdir(dir, { recursive: true });

  const token = crypto.randomBytes(8).toString('hex');
  const thumbFilename = `${token}-thumb.webp`;
  const fullFilename = `${token}-full.webp`;
  const thumbPath = path.join(dir, thumbFilename);
  const fullPath = path.join(dir, fullFilename);

  try {
    const source = sharp(buffer, { failOn: 'none' }).rotate();
    await source.clone().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath);
    await source.clone().resize({ width: FULL_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toFile(fullPath);
  } catch (err) {
    await fs.rm(thumbPath, { force: true }).catch(() => {});
    await fs.rm(fullPath, { force: true }).catch(() => {});
    const error = new Error('IMAGE_PROCESSING_FAILED');
    error.cause = err;
    throw error;
  }

  return {
    photoUrl: `/uploads/${venueId}/${fullFilename}`,
    photoThumbUrl: `/uploads/${venueId}/${thumbFilename}`,
  };
}

async function saveItemPhoto(venueId, buffer) {
  return saveVenueImage(venueId, buffer);
}

// Скриншот чека к заявке на оплату (промт 1.4) — тот же пайплайн (thumb+full webp), receipt_url
// хранит полноразмерную версию: чек нужно читать целиком (суммы/реквизиты), а не превью.
async function saveReceiptPhoto(venueId, buffer) {
  const { photoUrl } = await saveVenueImage(venueId, buffer);
  return photoUrl;
}

// --- иконки PWA (промт 2.5) ------------------------------------------------------------------

// Фон иконки — то же значение, что у токена --paper в design-system.css. В PNG переменные
// не работают, поэтому литералом; менять вместе с токеном.
const PWA_ICON_BACKGROUND = { r: 255, g: 253, b: 248, alpha: 1 };
// Промт: 192, 512 и maskable 512. У maskable содержимое вписывается в 80% холста — Android
// обрезает такую иконку по своей форме (круг, скруглённый квадрат), и всё, что выходит за
// безопасную зону, просто исчезает вместе с куском логотипа.
const PWA_SIZES = [
  { name: '192', size: 192, contentRatio: 1 },
  { name: '512', size: 512, contentRatio: 1 },
  { name: 'maskable-512', size: 512, contentRatio: 0.8 },
];

function pwaIconUrl(venueId, token, name) {
  return `/uploads/${venueId}/${token}-pwa-${name}.png`;
}

// Генерирует три иконки из логотипа заведения и возвращает общий токен-префикс их имён
// (venues.pwa_icons_token). Логотип может быть любой формы и с прозрачностью — подкладываем
// фон и вписываем внутрь холста через contain, чтобы ничего не обрезалось по краям.
async function saveVenuePwaIcons(venueId, buffer) {
  const dir = path.join(UPLOADS_ROOT, String(venueId));
  await fs.mkdir(dir, { recursive: true });

  const token = crypto.randomBytes(8).toString('hex');
  const written = [];

  try {
    for (const variant of PWA_SIZES) {
      const content = Math.round(variant.size * variant.contentRatio);
      const padding = Math.round((variant.size - content) / 2);
      const target = path.join(dir, `${token}-pwa-${variant.name}.png`);

      const resized = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({ width: content, height: content, fit: 'contain', background: PWA_ICON_BACKGROUND })
        .png()
        .toBuffer();

      await sharp({
        create: {
          width: variant.size, height: variant.size, channels: 4, background: PWA_ICON_BACKGROUND,
        },
      })
        .composite([{ input: resized, top: padding, left: padding }])
        .png()
        .toFile(target);

      written.push(target);
    }
  } catch (err) {
    await Promise.all(written.map((file) => fs.rm(file, { force: true }).catch(() => {})));
    const error = new Error('IMAGE_PROCESSING_FAILED');
    error.cause = err;
    throw error;
  }

  return token;
}

// Старые иконки удаляются по токену — имена файлов детерминированы, отдельного списка не нужно.
async function deleteVenuePwaIcons(venueId, token) {
  if (!token) return;
  const dir = path.join(UPLOADS_ROOT, String(venueId));
  await Promise.all(PWA_SIZES.map((variant) => (
    fs.rm(path.join(dir, `${token}-pwa-${variant.name}.png`), { force: true }).catch(() => {})
  )));
}

// Путь к уже сохранённому файлу логотипа — нужен, чтобы догенерировать иконки заведению,
// которое загрузило логотип до появления этой функции (ленивый догон при первом запросе
// манифеста, см. routes/publicPwa.js). Возвращает null, если файл не наш или не существует.
async function readLocalUpload(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const relative = url.replace(/^\/uploads\//, '');
  // Никаких переходов вверх по дереву: url приходит из БД, но заводится он из формы загрузки,
  // и полагаться на то, что там никогда не окажется '..', не стоит.
  if (relative.includes('..')) return null;
  const filePath = path.join(UPLOADS_ROOT, relative);
  if (!filePath.startsWith(UPLOADS_ROOT)) return null;
  return fs.readFile(filePath).catch(() => null);
}

// Промт 3.6: «Фото копируются ФИЗИЧЕСКИ в каталог нового заведения, а не переиспользуются
// по ссылке — иначе удаление в одном сломает другое».
//
// Копируются байты, а не пересжимается картинка: исходники уже прошли через saveVenueImage
// и лежат в нужных размерах webp. Повторное сжатие только потеряло бы качество и время.
// Токен новый — имена файлов в каталоге назначения не должны зависеть от исходных, иначе
// повторное копирование того же меню перезаписало бы уже скопированное.
//
// Возвращает null, если исходных файлов нет (позицию всё равно копируем, просто без фото:
// потерянная картинка — не повод отменить копирование всего меню).
async function copyItemPhotoFiles(targetVenueId, photoUrl, photoThumbUrl) {
  if (!photoUrl && !photoThumbUrl) return null;

  const dir = path.join(UPLOADS_ROOT, String(targetVenueId));
  await fs.mkdir(dir, { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const written = [];

  async function copyOne(url, suffix) {
    const buffer = await readLocalUpload(url);
    if (!buffer) return null;
    const filename = `${token}-${suffix}.webp`;
    await fs.writeFile(path.join(dir, filename), buffer);
    written.push(path.join(dir, filename));
    return `/uploads/${targetVenueId}/${filename}`;
  }

  try {
    const copied = {
      photoUrl: await copyOne(photoUrl, 'full'),
      photoThumbUrl: await copyOne(photoThumbUrl, 'thumb'),
      files: written,
    };
    return copied.photoUrl || copied.photoThumbUrl ? copied : null;
  } catch (err) {
    await Promise.all(written.map((file) => fs.rm(file, { force: true }).catch(() => {})));
    throw err;
  }
}

// Удаление по списку абсолютных путей — компенсация для копирования меню: если транзакция
// откатилась, скопированные файлы должны исчезнуть вместе с несостоявшимися строками.
async function deleteFiles(paths) {
  await Promise.all(paths.map((file) => fs.rm(file, { force: true }).catch(() => {})));
}

async function deleteItemPhotoFiles(photoUrl, photoThumbUrl) {
  for (const url of [photoUrl, photoThumbUrl]) {
    if (!url) continue;
    const relative = url.replace(/^\/uploads\//, '');
    const filePath = path.join(UPLOADS_ROOT, relative);
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

module.exports = {
  saveItemPhoto,
  saveReceiptPhoto,
  copyItemPhotoFiles,
  deleteFiles,
  deleteItemPhotoFiles,
  saveVenuePwaIcons,
  deleteVenuePwaIcons,
  readLocalUpload,
  pwaIconUrl,
  PWA_SIZES,
};
