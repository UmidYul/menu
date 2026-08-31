const { z } = require('zod');

const ALLOWED_TAGS = ['halal', 'vegan', 'vegetarian', 'spicy', 'new'];

const tagsField = z
  .union([z.array(z.string()), z.string(), z.undefined()])
  .transform((val) => {
    if (val === undefined) return [];
    return Array.isArray(val) ? val : [val];
  })
  .refine((tags) => tags.every((t) => ALLOWED_TAGS.includes(t)), {
    message: 'items.errorInvalidTag',
  });

const itemSchema = z.object({
  category_id: z.coerce.number({ invalid_type_error: 'items.errorCategoryRequired' }).int().positive('items.errorCategoryRequired'),
  name_ru: z.string().trim().min(1, 'items.errorNameRuRequired').max(200, 'items.errorTooLong'),
  name_uz: z.string().trim().min(1, 'items.errorNameUzRequired').max(200, 'items.errorTooLong'),
  description_ru: z
    .string()
    .trim()
    .max(2000, 'items.errorTooLong')
    .optional()
    .transform((v) => v || null),
  description_uz: z
    .string()
    .trim()
    .max(2000, 'items.errorTooLong')
    .optional()
    .transform((v) => v || null),
  composition_ru: z
    .string()
    .trim()
    .max(2000, 'items.errorTooLong')
    .optional()
    .transform((v) => v || null),
  composition_uz: z
    .string()
    .trim()
    .max(2000, 'items.errorTooLong')
    .optional()
    .transform((v) => v || null),
  calories: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
    .refine((v) => v === undefined || /^\d+$/.test(v), { message: 'items.errorCaloriesInvalid' })
    .transform((v) => (v === undefined ? null : Number(v))),
  price: z.coerce.number({ invalid_type_error: 'items.errorPriceRequired' }).min(0, 'items.errorPriceNegative'),
  old_price: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
    .refine((v) => v === undefined || /^\d+(\.\d{1,2})?$/.test(v), { message: 'items.errorOldPriceInvalid' })
    .transform((v) => (v === undefined ? null : Number(v))),
  currency: z.string().trim().min(1, 'items.errorCurrencyRequired').max(10, 'items.errorTooLong').default('UZS'),
  tags: tagsField,
}).refine((data) => data.old_price === null || data.old_price > data.price, {
  message: 'items.errorOldPriceNotGreater',
  path: ['old_price'],
});

module.exports = { itemSchema, ALLOWED_TAGS };
