const { z } = require('zod');

const categorySchema = z.object({
  name_ru: z.string().trim().min(1, 'categories.errorEmptyNameRu'),
  name_uz: z.string().trim().min(1, 'categories.errorEmptyNameUz'),
});

module.exports = { categorySchema };
