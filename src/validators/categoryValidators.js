const { z } = require('zod');
const { hiddenModeField } = require('./scheduleValidators');

const categorySchema = z.object({
  name_ru: z.string().trim().min(1, 'categories.errorEmptyNameRu').max(200, 'categories.errorTooLong'),
  name_uz: z.string().trim().min(1, 'categories.errorEmptyNameUz').max(200, 'categories.errorTooLong'),
  name_en: z
    .string()
    .trim()
    .max(200, 'categories.errorTooLong')
    .optional()
    .transform((v) => v || null),
  // Промт 2.3: что делать с позициями категории, которые сейчас вне расписания. Поля нет
  // в форме создания категории (расписания у новой категории ещё нет) — значение по умолчанию
  // 'dim' подставляет сам валидатор, см. scheduleValidators.hiddenModeField.
  schedule_hidden_mode: hiddenModeField,
});

module.exports = { categorySchema };
