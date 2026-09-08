const multer = require('multer');

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 МБ
const MAX_RECEIPT_SIZE_BYTES = 5 * 1024 * 1024; // 5 МБ — отдельный, меньший лимит для чеков (промт 1.4)

// Промт 4.2: «проверка не только по MIME из заголовка (он подделывается), но и по магическим
// байтам». MIME проверяется здесь — это дешёвый первый отсев ДО того, как файл будет прочитан
// целиком. Настоящая проверка содержимого делается после, в assertRealImage: до полной загрузки
// в память байтов ещё нет, а multer вызывает fileFilter именно до неё.
const imageFileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('INVALID_FILE_TYPE'));
  }
  cb(null, true);
};

// Сигнатуры форматов, которые мы принимаем. Заголовок Content-Type подделывается тривиально,
// а вот первые байты файла — это то, чем он является на самом деле.
// Проверка не заменяет sharp (тот всё равно откажется обрабатывать мусор), а стоит ДО него:
// так «переименованный в .jpg» PHP-скрипт или HTML со скриптом отсекается до попадания
// в обработку, и в лог попадает понятная причина, а не «IMAGE_PROCESSING_FAILED».
const IMAGE_SIGNATURES = [
  { name: 'jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { name: 'png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { name: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'bmp', bytes: [0x42, 0x4D] },
];

function matchesSignature(buffer, signature) {
  if (buffer.length < signature.bytes.length) return false;
  return signature.bytes.every((byte, index) => buffer[index] === byte);
}

// webp и heic опознаются не по первым байтам, а по контейнеру: RIFF....WEBP и ....ftypheic.
function isWebp(buffer) {
  return buffer.length > 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP';
}

function isHeic(buffer) {
  if (buffer.length < 12) return false;
  const brand = buffer.toString('ascii', 4, 12);
  return brand.startsWith('ftyp') && /heic|heix|hevc|mif1|msf1/.test(brand);
}

// Возвращает имя формата или null. Экспортируется, чтобы её можно было прогнать в проверках
// без поднятия HTTP-сервера.
function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (isWebp(buffer)) return 'webp';
  if (isHeic(buffer)) return 'heic';
  const match = IMAGE_SIGNATURES.find((signature) => matchesSignature(buffer, signature));
  return match ? match.name : null;
}

// Проверяет все загруженные в запросе файлы. Если хоть один не изображение по содержимому —
// req.uploadError выставляется тем же способом, что и при ошибке multer, и роут покажет
// обычное сообщение вместо падения.
function assertRealImages(req, res) {
  const files = [];
  if (req.file) files.push(req.file);
  if (req.files) {
    if (Array.isArray(req.files)) files.push(...req.files);
    else Object.values(req.files).forEach((list) => files.push(...list));
  }

  for (const file of files) {
    if (!file.buffer || detectImageFormat(file.buffer) === null) {
      const { t } = res.locals;
      req.uploadError = t('items.errorImageType');
      return false;
    }
  }
  return true;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: imageFileFilter,
});

const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_SIZE_BYTES },
  fileFilter: imageFileFilter,
});

// Оборачиваем multer вручную, чтобы превратить ошибку загрузки (слишком большой файл,
// не изображение) в понятное сообщение, а не голову express-ошибку.
function uploadItemPhoto(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      const { t } = res.locals;
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.uploadError = t('items.errorImageTooBig', { maxMb: MAX_FILE_SIZE_BYTES / (1024 * 1024) });
      } else if (err.message === 'INVALID_FILE_TYPE') {
        req.uploadError = t('items.errorImageType');
      } else {
        req.uploadError = t('items.errorImageGeneric');
      }
      return next();
    }
    assertRealImages(req, res);
    return next();
  });
}

// Настройки заведения грузят до двух картинок разом (лого + обложка) под разными полями формы.
function uploadVenueImages(req, res, next) {
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      const { t } = res.locals;
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.uploadError = t('items.errorImageTooBig', { maxMb: MAX_FILE_SIZE_BYTES / (1024 * 1024) });
      } else if (err.message === 'INVALID_FILE_TYPE') {
        req.uploadError = t('items.errorImageType');
      } else {
        req.uploadError = t('items.errorImageGeneric');
      }
      return next();
    }
    assertRealImages(req, res);
    return next();
  });
}

// Заявка на оплату несёт необязательный скриншот чека под полем "receipt", тем же полем формы,
// что "photo"/"logo"/"cover" выше, просто на новом инстансе multer с меньшим лимитом (5 МБ,
// см. константу выше — у чека нет причин быть таким же большим, как фото блюда).
function uploadReceiptPhoto(req, res, next) {
  uploadReceipt.single('receipt')(req, res, (err) => {
    if (err) {
      const { t } = res.locals;
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.uploadError = t('subscription.errorReceiptTooBig', { maxMb: MAX_RECEIPT_SIZE_BYTES / (1024 * 1024) });
      } else if (err.message === 'INVALID_FILE_TYPE') {
        req.uploadError = t('subscription.errorReceiptType');
      } else {
        req.uploadError = t('items.errorImageGeneric');
      }
      return next();
    }
    assertRealImages(req, res);
    return next();
  });
}

module.exports = { uploadItemPhoto, uploadVenueImages, uploadReceiptPhoto, detectImageFormat };
