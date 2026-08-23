const { z } = require('zod');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

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

const workingHoursShape = {};
DAYS.forEach((day) => {
  workingHoursShape[day] = z
    .string()
    .trim()
    .optional()
    .transform((v) => v || '');
});

const venueSettingsSchema = z.object({
  phone: optionalText,
  address: optionalText,
  address_2gis_url: optionalUrl,
  instagram_url: optionalUrl,
  telegram_url: optionalUrl,
  working_hours: z.object(workingHoursShape),
});

module.exports = { venueSettingsSchema, DAYS };
