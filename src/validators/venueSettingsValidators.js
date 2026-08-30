const { z } = require('zod');

const optionalText = z
  .string()
  .trim()
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
    phone: optionalText,
    address: optionalText,
    address_2gis_url: optionalUrl,
    wifi_ssid: optionalText,
    wifi_password: optionalText,
    instagram_url: optionalUrl,
    telegram_url: optionalUrl,
    working_hours: optionalText,
    description_ru: optionalText,
    description_uz: optionalText,
    cuisine_ru: optionalText,
    cuisine_uz: optionalText,
    category_label_ru: optionalText,
    category_label_uz: optionalText,
    district_ru: optionalText,
    district_uz: optionalText,
    email: optionalEmail,
  })
  .refine((data) => (data.wifi_ssid === null) === (data.wifi_password === null), {
    message: 'venueSettings.errorWifiIncomplete',
    path: ['wifi_ssid'],
  });

module.exports = { venueSettingsSchema };
