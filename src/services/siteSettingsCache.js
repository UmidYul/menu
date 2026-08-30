const siteSettingsModel = require('../models/siteSettingsModel');

// Настройки сайта меняются только вручную суперадмином, поэтому в отличие от menuCache
// здесь не нужен TTL — просто держим последнюю прочитанную строку в памяти процесса,
// пока её явно не инвалидируют сохранением из /superadmin/site-settings.
let cached = null;

async function get() {
  if (!cached) cached = await siteSettingsModel.get();
  return cached;
}

function invalidate() {
  cached = null;
}

module.exports = { get, invalidate };
