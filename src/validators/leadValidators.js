const { z } = require('zod');
const { normalizeUzPhone } = require('../utils/phone');

const VENUE_TYPES = ['coffee', 'cafe', 'pizza_sushi', 'bar', 'streetfood', 'confectionery', 'other'];

const contactNameField = z.string().trim().min(2, 'apply.errorContactNameLength').max(100, 'apply.errorContactNameLength');
const venueNameField = z.string().trim().min(2, 'apply.errorVenueNameLength').max(100, 'apply.errorVenueNameLength');
const cityField = z.string().trim().max(100, 'apply.errorTooLong').optional().transform((v) => v || null);
const venueTypeField = z.enum(VENUE_TYPES, { errorMap: () => ({ message: 'apply.errorVenueTypeRequired' }) });
const commentField = z.string().trim().max(1000, 'apply.errorTooLong').optional().transform((v) => v || null);

// Принимает любой ввод ("90 123 45 67", "+998901234567", "998 90 123 45 67") и приводит
// к +998XXXXXXXXX — normalizeUzPhone возвращает null, если это в принципе не похоже на номер.
const normalizedPhoneField = z
  .string()
  .transform((v) => normalizeUzPhone(v))
  .refine((v) => v !== null, { message: 'apply.errorPhoneInvalid' });

// Заявка через сайт: те же поля + email, согласие с условиями, honeypot и тайминг —
// последние два не про "правильность" ввода, а про антиспам (см. routes/apply.js).
const applyFormSchema = z.object({
  venue_name: venueNameField,
  city: cityField,
  venue_type: venueTypeField,
  contact_name: contactNameField,
  phone: normalizedPhoneField,
  email: z
    .string()
    .trim()
    .max(200, 'apply.errorTooLong')
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'apply.errorEmailInvalid' }),
  comment: commentField,
  consent: z.literal('on', { errorMap: () => ({ message: 'apply.errorConsentRequired' }) }),
  website: z.string().max(0, 'apply.errorSpam').optional().transform((v) => v || ''), // honeypot
  form_rendered_at: z.string(),
});

// Причина отказа — суперадминка (форма) и бот (следующим сообщением после кнопки "Отклонить")
// приводят её к одному и тому же виду перед вызовом leadApproval.rejectLead.
const rejectReasonSchema = z.object({
  reason: z.string().trim().min(1, 'superadmin.errorRejectReasonRequired').max(500, 'superadmin.errorTooLong'),
});

module.exports = {
  VENUE_TYPES,
  contactNameField,
  venueNameField,
  cityField,
  venueTypeField,
  commentField,
  normalizedPhoneField,
  applyFormSchema,
  rejectReasonSchema,
};
