const { z } = require('zod');

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
    cuisine_ru: optionalText(100),
    cuisine_uz: optionalText(100),
    category_label_ru: optionalText(100),
    category_label_uz: optionalText(100),
    district_ru: optionalText(100),
    district_uz: optionalText(100),
    email: optionalEmail,
  })
  .refine((data) => (data.wifi_ssid === null) === (data.wifi_password === null), {
    message: 'venueSettings.errorWifiIncomplete',
    path: ['wifi_ssid'],
  });

module.exports = { venueSettingsSchema };
