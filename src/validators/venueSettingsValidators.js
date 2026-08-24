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

const optionalCoordinate = (min, max) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v !== '' ? v : undefined))
    .refine((v) => v === undefined || (!Number.isNaN(Number(v)) && Number(v) >= min && Number(v) <= max), {
      message: 'venueSettings.errorInvalidCoordinate',
    })
    .transform((v) => (v === undefined ? null : Number(v)));

const venueSettingsSchema = z
  .object({
    phone: optionalText,
    address: optionalText,
    address_2gis_url: optionalUrl,
    latitude: optionalCoordinate(-90, 90),
    longitude: optionalCoordinate(-180, 180),
    wifi_ssid: optionalText,
    wifi_password: optionalText,
    instagram_url: optionalUrl,
    telegram_url: optionalUrl,
  })
  .refine((data) => (data.latitude === null) === (data.longitude === null), {
    message: 'venueSettings.errorCoordinatesIncomplete',
    path: ['latitude'],
  })
  .refine((data) => (data.wifi_ssid === null) === (data.wifi_password === null), {
    message: 'venueSettings.errorWifiIncomplete',
    path: ['wifi_ssid'],
  });

module.exports = { venueSettingsSchema };
