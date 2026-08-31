const { z } = require('zod');
const { SUPPORTED_LANGS } = require('../i18n');

const optionalText = (maxLen) =>
  z
    .string()
    .trim()
    .max(maxLen, 'venueSettings.errorTooLong')
    .optional()
    .transform((v) => v || null);

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || /^https?:\/\/.+/i.test(v), {
    message: 'venueSettings.errorInvalidUrl',
  });

const optionalEmail = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
    message: 'venueSettings.errorInvalidEmail',
  });

// Чекбоксы enabled_langs[]: браузер шлёт одну строку при одном отмеченном языке и массив —
// при нескольких (как tagsField в itemValidators.js). Значения вне SUPPORTED_LANGS отбрасываем —
// через обычную форму их взяться неоткуда, кроме случайно собранного запроса.
const enabledLangsField = z
  .union([z.array(z.string()), z.string(), z.undefined()])
  .transform((val) => {
    const arr = val === undefined ? [] : Array.isArray(val) ? val : [val];
    return arr.filter((lang) => SUPPORTED_LANGS.includes(lang));
  })
  .refine((langs) => langs.length > 0, { message: 'venueSettings.errorEnabledLangsEmpty' });

const venueSettingsSchema = z
  .object({
    phone: optionalText(30),
    address: optionalText(300),
    address_2gis_url: optionalUrl,
    wifi_ssid: optionalText(100),
    wifi_password: optionalText(100),
    instagram_url: optionalUrl,
    telegram_url: optionalUrl,
    working_hours: optionalText(300),
    description_ru: optionalText(2000),
    description_uz: optionalText(2000),
    description_en: optionalText(2000),
    cuisine_ru: optionalText(100),
    cuisine_uz: optionalText(100),
    cuisine_en: optionalText(100),
    category_label_ru: optionalText(100),
    category_label_uz: optionalText(100),
    category_label_en: optionalText(100),
    district_ru: optionalText(100),
    district_uz: optionalText(100),
    district_en: optionalText(100),
    email: optionalEmail,
    enabled_langs: enabledLangsField,
    lang_default: z.enum(SUPPORTED_LANGS, {
      errorMap: () => ({ message: 'venueSettings.errorLangDefaultNotEnabled' }),
    }),
  })
  .refine((data) => (data.wifi_ssid === null) === (data.wifi_password === null), {
    message: 'venueSettings.errorWifiIncomplete',
    path: ['wifi_ssid'],
  })
  .refine((data) => data.enabled_langs.includes(data.lang_default), {
    message: 'venueSettings.errorLangDefaultNotEnabled',
    path: ['lang_default'],
  });

module.exports = { venueSettingsSchema };
