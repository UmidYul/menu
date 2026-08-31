const multer = require('multer');

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 МБ
const MAX_RECEIPT_SIZE_BYTES = 5 * 1024 * 1024; // 5 МБ — отдельный, меньший лимит для чеков (промт 1.4)

const imageFileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('INVALID_FILE_TYPE'));
  }
  cb(null, true);
};

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
    }
    next();
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
    }
    next();
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
    }
    next();
  });
}

module.exports = { uploadItemPhoto, uploadVenueImages, uploadReceiptPhoto };
