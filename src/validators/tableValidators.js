const { z } = require('zod');

// Промт 2.4. Верхняя граница массового создания — не из промта, а здравый смысл: «создать столы
// 1–20» это типовой сценарий, 500 столов за один сабмит почти наверняка опечатка в поле «до».
const MAX_BULK_TABLES = 200;
const MAX_NUMBER_LENGTH = 40;

const tableNumberSchema = z.object({
  number: z
    .string()
    .trim()
    .min(1, 'tables.errorNumberRequired')
    .max(MAX_NUMBER_LENGTH, 'tables.errorNumberTooLong'),
});

const positiveIntFromForm = z
  .string()
  .trim()
  .refine((v) => /^\d+$/.test(v), { message: 'tables.errorRangeInvalid' })
  .transform((v) => Number(v));

const bulkCreateSchema = z
  .object({
    from: positiveIntFromForm,
    to: positiveIntFromForm,
    // Необязательный префикс: «Терраса 1..6» вместо «1..6» — номер стола у нас текстовый,
    // и это самый частый вид «нечислового» номера (см. комментарий в миграции venue_tables).
    prefix: z.string().trim().max(MAX_NUMBER_LENGTH, 'tables.errorNumberTooLong').optional().transform((v) => v || ''),
  })
  .refine((data) => data.from <= data.to, { message: 'tables.errorRangeReversed', path: ['to'] })
  .refine((data) => data.to - data.from + 1 <= MAX_BULK_TABLES, { message: 'tables.errorRangeTooBig', path: ['to'] })
  .refine((data) => (data.prefix ? data.prefix.length + String(data.to).length + 1 : String(data.to).length) <= MAX_NUMBER_LENGTH, {
    message: 'tables.errorNumberTooLong',
    path: ['prefix'],
  });

// [from..to] -> ['1','2',...] либо ['Терраса 1', ...] — сама генерация имён, чтобы роут не
// занимался форматированием.
function buildNumbers({ from, to, prefix }) {
  const numbers = [];
  for (let i = from; i <= to; i += 1) {
    numbers.push(prefix ? `${prefix} ${i}` : String(i));
  }
  return numbers;
}

module.exports = { tableNumberSchema, bulkCreateSchema, buildNumbers, MAX_BULK_TABLES, MAX_NUMBER_LENGTH };
