const { z } = require('zod');

// Промт 3.3, edge case: «очень длинный комментарий — ограничить 2000 символов на сервере».
const MAX_COMMENT_LENGTH = 2000;
const MAX_CONTACT_LENGTH = 120;

const reviewSubmitSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(MAX_COMMENT_LENGTH).optional().transform((v) => v || null),
  // Телефон или Telegram — как гость привык, без навязанного формата: жёсткая маска здесь
  // только отпугнёт, а связываться с гостем всё равно будет человек, а не автомат.
  contact: z.string().trim().max(MAX_CONTACT_LENGTH).optional().transform((v) => v || null),
  // Гость нажал «Отзыв в Google/Яндексе», ещё не отправив форму: браузер уже уходит по ссылке,
  // поэтому отзыв и отметка о переходе сохраняются одним запросом (sendBeacon), а не двумя.
  external: z.enum(['google', 'yandex']).optional(),
});

const externalClickSchema = z.object({
  reviewId: z.coerce.number().int().positive(),
  target: z.enum(['google', 'yandex']),
});

// Настройки сбора отзывов в админке заведения.
const optionalReviewUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || /^https?:\/\/.+/i.test(v), { message: 'reviews.errorInvalidUrl' });

const reviewsSettingsSchema = z.object({
  google_review_url: optionalReviewUrl,
  yandex_review_url: optionalReviewUrl,
  reviews_prompt_delay_sec: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? '45' : v))
    .refine((v) => /^\d+$/.test(v), { message: 'reviews.errorDelayInvalid' })
    .transform((v) => Number(v))
    .refine((v) => v >= 0 && v <= 3600, { message: 'reviews.errorDelayInvalid' }),
  reviews_threshold: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? '4' : v))
    .refine((v) => /^[1-5]$/.test(v), { message: 'reviews.errorThresholdInvalid' })
    .transform((v) => Number(v)),
});

module.exports = {
  reviewSubmitSchema,
  externalClickSchema,
  reviewsSettingsSchema,
  MAX_COMMENT_LENGTH,
  MAX_CONTACT_LENGTH,
};
