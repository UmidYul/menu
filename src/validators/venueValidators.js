const { z } = require('zod');

const slugRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Рейтинг/отзывы — модерационное поле доверия, задаёт только суперадмин. Оба значения
// опциональны независимо друг от друга: можно очистить рейтинг, оставив карточку без него.
const optionalRating = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
  .refine((v) => v === undefined || /^\d(\.\d)?$/.test(v), { message: 'superadmin.errorInvalidRating' })
  .transform((v) => (v === undefined ? null : Number(v)))
  .refine((v) => v === null || (v >= 0 && v <= 5), { message: 'superadmin.errorInvalidRating' });

const optionalReviewCount = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))
  .refine((v) => v === undefined || /^\d+$/.test(v), { message: 'superadmin.errorInvalidReviewCount' })
  .transform((v) => (v === undefined ? null : Number(v)));

const venueRatingSchema = z.object({
  rating: optionalRating,
  review_count: optionalReviewCount,
});

const createVenueSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1, 'superadmin.errorSlugRequired')
    .max(60, 'superadmin.errorTooLong')
    .regex(slugRegex, 'superadmin.errorSlugFormat'),
  name: z.string().trim().min(1, 'superadmin.errorNameRequired').max(200, 'superadmin.errorTooLong'),
  lang_default: z.enum(['ru', 'uz'], {
    errorMap: () => ({ message: 'superadmin.errorLangRequired' }),
  }),
  admin_login: z.string().trim().min(3, 'superadmin.errorAdminLoginTooShort').max(50, 'superadmin.errorTooLong'),
  // bcrypt тихо обрезает вход длиннее 72 байт — сверху всё, что дальше, просто не участвует
  // в хеше. Ограничиваем явно, чтобы это не оказалось сюрпризом при попытке войти длинным паролем.
  admin_password: z.string().min(10, 'superadmin.errorAdminPasswordTooShort').max(72, 'superadmin.errorTooLong'),
});

module.exports = { createVenueSchema, venueRatingSchema };
