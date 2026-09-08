const { z } = require('zod');

const optionalText = (maxLen) =>
  z
    .string()
    .trim()
    .max(maxLen, 'siteSettings.errorTooLong')
    .optional()
    .transform((v) => v || null);

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || /^https?:\/\/.+/i.test(v), {
    message: 'siteSettings.errorInvalidUrl',
  });

const optionalEmail = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
    message: 'siteSettings.errorInvalidEmail',
  });

const optionalPhone = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || /^[+]?[\d\s()-]{5,25}$/.test(v), {
    message: 'siteSettings.errorInvalidPhone',
  });

const siteSettingsSchema = z.object({
  owner_name: optionalText(150),
  phone: optionalPhone,
  phone_extra: optionalPhone,
  email: optionalEmail,
  telegram_url: optionalUrl,
  instagram_url: optionalUrl,
  address_ru: optionalText(300),
  address_uz: optionalText(300),
  working_hours_ru: optionalText(300),
  working_hours_uz: optionalText(300),
  about_ru: optionalText(600),
  about_uz: optionalText(600),
  offer_url: optionalUrl,
  privacy_url: optionalUrl,
  // Домен для печатных макетов (промт 3.4): владелец пишет его так, как он будет напечатан —
  // «menuva.uz», без схемы и слэшей. Схему принимаем и срезаем сами, чтобы ввод «https://...»
  // не превращался в мусор на бумаге.
  print_domain: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v || '').replace(/^https?:\/\//i, '').replace(/\/+$/, ''))
    .transform((v) => v || null)
    .refine((v) => v === null || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v), {
      message: 'siteSettings.errorInvalidDomain',
    }),
  payment_card_number: optionalText(30),
  payment_card_holder: optionalText(100),
  payment_bank_name: optionalText(100),
  payment_instructions_ru: optionalText(600),
  payment_instructions_uz: optionalText(600),
  payment_instructions_en: optionalText(600),
});

module.exports = { siteSettingsSchema };
