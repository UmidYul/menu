const multer = require('multer');

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 МБ

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('INVALID_FILE_TYPE'));
    }
    cb(null, true);
  },
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

module.exports = { uploadItemPhoto, uploadVenueImages };
