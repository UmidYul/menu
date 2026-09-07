const { z } = require('zod');

// Лимиты проверяются В ВАЛИДАТОРЕ (а не только в БД) — из БД такое ограничение вернулось бы
// нечитаемым текстом нарушения constraint'а вместо понятного человеку сообщения.
const MAX_GROUPS_PER_ITEM = 5;
const MAX_OPTIONS_PER_GROUP = 20;

const SELECTIONS = ['single', 'multiple'];

const optionalName = z
  .string()
  .trim()
  .max(120, 'itemOptions.errorTooLong')
  .optional()
  .transform((v) => v || null);

const checkboxToBool = z
  .union([z.string(), z.undefined()])
  .transform((v) => v === 'on' || v === 'true' || v === '1');

const optionalPositiveInt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
  .refine((v) => v === undefined || /^\d+$/.test(v), { message: 'itemOptions.errorLimitInvalid' })
  .transform((v) => (v === undefined ? null : Number(v)));

const groupSchema = z
  .object({
    name_ru: z.string().trim().min(1, 'itemOptions.errorGroupNameRuRequired').max(120, 'itemOptions.errorTooLong'),
    name_uz: z.string().trim().min(1, 'itemOptions.errorGroupNameUzRequired').max(120, 'itemOptions.errorTooLong'),
    name_en: optionalName,
    selection: z.enum(SELECTIONS, { errorMap: () => ({ message: 'itemOptions.errorSelectionInvalid' }) }),
    is_required: checkboxToBool,
    min_select: optionalPositiveInt,
    max_select: optionalPositiveInt,
  })
  .transform((data) => ({
    ...data,
    // Пустое поле = 0 обязательных к выбору; для single максимум всегда ровно 1 (CHECK в БД
    // требует того же, но подставляем здесь, чтобы форма не заставляла вводить это руками).
    min_select: data.min_select === null ? 0 : data.min_select,
    max_select: data.selection === 'single' ? 1 : data.max_select,
  }))
  .refine((data) => data.max_select === null || data.max_select >= data.min_select, {
    message: 'itemOptions.errorMaxLessThanMin',
    path: ['max_select'],
  })
  .refine((data) => data.selection !== 'single' || data.min_select <= 1, {
    message: 'itemOptions.errorSingleMinTooBig',
    path: ['min_select'],
  })
  // Обязательная группа, из которой нечего выбрать обязательным, — противоречие: is_required
  // без min_select >= 1 не заставит гостя ничего выбрать, и кнопка "Добавить" никогда не
  // разблокируется по этому признаку. Приводим к явному виду вместо тихого несоответствия.
  .refine((data) => !data.is_required || data.min_select >= 1, {
    message: 'itemOptions.errorRequiredNeedsMin',
    path: ['min_select'],
  });

const optionSchema = z.object({
  name_ru: z.string().trim().min(1, 'itemOptions.errorOptionNameRuRequired').max(120, 'itemOptions.errorTooLong'),
  name_uz: z.string().trim().min(1, 'itemOptions.errorOptionNameUzRequired').max(120, 'itemOptions.errorTooLong'),
  name_en: optionalName,
  // Надбавка в сумах, целыми числами (промт 2.1). 0 допустим и означает "без доплаты".
  price_delta: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : '0'))
    .refine((v) => /^\d+$/.test(v), { message: 'itemOptions.errorPriceDeltaInvalid' })
    .transform((v) => Number(v)),
  is_available: checkboxToBool,
  is_default: checkboxToBool,
});

const copyGroupSchema = z.object({
  group_id: z.coerce.number({ invalid_type_error: 'itemOptions.errorGroupNotFound' }).int().positive('itemOptions.errorGroupNotFound'),
  target_item_ids: z
    .union([z.array(z.string()), z.string(), z.undefined()])
    .transform((v) => {
      if (v === undefined) return [];
      return (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    })
    .refine((ids) => ids.length > 0, { message: 'itemOptions.errorNoTargetItems' }),
});

module.exports = {
  MAX_GROUPS_PER_ITEM,
  MAX_OPTIONS_PER_GROUP,
  SELECTIONS,
  groupSchema,
  optionSchema,
  copyGroupSchema,
};
