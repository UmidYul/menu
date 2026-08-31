const { z } = require('zod');

const categorySchema = z.object({
  name_ru: z.string().trim().min(1, 'categories.errorEmptyNameRu').max(200, 'categories.errorTooLong'),
  name_uz: z.string().trim().min(1, 'categories.errorEmptyNameUz').max(200, 'categories.errorTooLong'),
  name_en: z
    .string()
    .trim()
    .max(200, 'categories.errorTooLong')
    .optional()
    .transform((v) => v || null),
});

module.exports = { categorySchema };
