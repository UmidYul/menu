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
  name_ru: z.string().trim().min(1, 'items.errorNameRuRequired'),
  name_uz: z.string().trim().min(1, 'items.errorNameUzRequired'),
  description_ru: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null),
  description_uz: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null),
  price: z.coerce.number({ invalid_type_error: 'items.errorPriceRequired' }).min(0, 'items.errorPriceNegative'),
  currency: z.string().trim().min(1, 'items.errorCurrencyRequired').default('UZS'),
  tags: tagsField,
});

module.exports = { itemSchema, ALLOWED_TAGS };
