const { z } = require('zod');

const ALLOWED_TAGS = [
  'halal', 'vegan', 'vegetarian', 'spicy', 'new', 'lactose_free', 'gluten_free', 'chef_choice',
];
const ALLOWED_ALLERGENS = [
  'gluten', 'milk', 'eggs', 'nuts', 'peanuts', 'fish', 'seafood', 'soy', 'sesame', 'celery', 'mustard', 'sulphites',
];
const WEIGHT_UNITS = ['g', 'ml', 'pcs'];
const MAX_SPICY_LEVEL = 3;

// Чекбоксы приходят либо массивом, либо одной строкой, либо не приходят вовсе — приводим
// к массиву до проверки на допустимые значения (тот же приём и для тегов, и для аллергенов).
function checkboxListField(allowed, message) {
  return z
    .union([z.array(z.string()), z.string(), z.undefined()])
    .transform((val) => {
      if (val === undefined) return [];
      return Array.isArray(val) ? val : [val];
    })
    .refine((values) => values.every((v) => allowed.includes(v)), { message });
}

const tagsField = checkboxListField(ALLOWED_TAGS, 'items.errorInvalidTag');
const allergensField = checkboxListField(ALLOWED_ALLERGENS, 'items.errorInvalidAllergen');

const optionalPositiveNumber = (message) => z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
  .refine((v) => v === undefined || (/^\d+([.,]\d{1,2})?$/.test(v) && Number(v.replace(',', '.')) > 0), { message })
  .transform((v) => (v === undefined ? null : Number(v.replace(',', '.'))));

const optionalPositiveInt = (message) => z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
  .refine((v) => v === undefined || (/^\d+$/.test(v) && Number(v) > 0), { message })
  .transform((v) => (v === undefined ? null : Number(v)));

const itemSchema = z.object({
  category_id: z.coerce.number({ invalid_type_error: 'items.errorCategoryRequired' }).int().positive('items.errorCategoryRequired'),
  name_ru: z.string().trim().min(1, 'items.errorNameRuRequired').max(200, 'items.errorTooLong'),
  name_uz: z.string().trim().min(1, 'items.errorNameUzRequired').max(200, 'items.errorTooLong'),
  name_en: z
    .string()
    .trim()
    .max(200, 'items.errorTooLong')
    .optional()
    .transform((v) => v || null),
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
  description_en: z
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
  composition_en: z
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
  // Расширенные данные о позиции (промт 2.2) — все необязательные.
  weight_value: optionalPositiveNumber('items.errorWeightInvalid'),
  weight_unit: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : null))
    .refine((v) => v === null || WEIGHT_UNITS.includes(v), { message: 'items.errorWeightUnitInvalid' }),
  cooking_time_minutes: optionalPositiveInt('items.errorCookingTimeInvalid'),
  allergens: allergensField,
  spicy_level: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
    .refine((v) => v === undefined || (/^\d$/.test(v) && Number(v) <= MAX_SPICY_LEVEL), { message: 'items.errorSpicyLevelInvalid' })
    .transform((v) => (v === undefined ? null : Number(v))),
  is_popular: z
    .union([z.string(), z.undefined()])
    .transform((v) => v === 'on' || v === 'true' || v === '1'),
})
  .refine((data) => data.old_price === null || data.old_price > data.price, {
    message: 'items.errorOldPriceNotGreater',
    path: ['old_price'],
  })
  // Вес без единицы измерения (и наоборот) — половина данных, которую нечего показать гостю:
  // "300" без грамм/мл ничего не значит, а "мл" без числа тем более.
  .refine((data) => (data.weight_value === null) === (data.weight_unit === null), {
    message: 'items.errorWeightPairRequired',
    path: ['weight_value'],
  });

module.exports = { itemSchema, ALLOWED_TAGS, ALLOWED_ALLERGENS, WEIGHT_UNITS, MAX_SPICY_LEVEL };
