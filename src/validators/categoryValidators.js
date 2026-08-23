const { z } = require('zod');

const categorySchema = z.object({
  name_ru: z.string().trim().min(1, 'Введите название категории на русском'),
  name_uz: z.string().trim().min(1, 'Введите название категории на узбекском'),
});

module.exports = { categorySchema };
