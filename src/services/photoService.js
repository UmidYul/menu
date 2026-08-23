const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'public', 'uploads');

const THUMB_WIDTH = 200;
const FULL_WIDTH = 800;

async function saveItemPhoto(venueId, buffer) {
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

async function deleteItemPhotoFiles(photoUrl, photoThumbUrl) {
  for (const url of [photoUrl, photoThumbUrl]) {
    if (!url) continue;
    const relative = url.replace(/^\/uploads\//, '');
    const filePath = path.join(UPLOADS_ROOT, relative);
    await fs.rm(filePath, { force: true }).catch(() => {});
  }
}

module.exports = { saveItemPhoto, deleteItemPhotoFiles };
