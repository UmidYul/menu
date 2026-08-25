const { z } = require('zod');
const { DATE_ONLY_REGEX } = require('../utils/dateOnly');

const PAYMENT_METHODS = ['cash', 'card', 'click', 'payme', 'other'];
const PERIOD_MONTHS = ['1', '3', '6'];

const extendSubscriptionSchema = z
  .object({
    amount: z.coerce
      .number({ invalid_type_error: 'superadmin.errorAmountInvalid' })
      .positive('superadmin.errorAmountPositive'),
    method: z.enum(PAYMENT_METHODS, {
      errorMap: () => ({ message: 'superadmin.errorMethodRequired' }),
    }),
    comment: z
      .string()
      .trim()
      .max(500, 'superadmin.errorCommentTooLong')
      .optional()
      .transform((v) => v || null),
    paid_at: z.string().trim().regex(DATE_ONLY_REGEX, 'superadmin.errorPaidAtInvalid'),
    period_mode: z.enum(['preset', 'manual'], {
      errorMap: () => ({ message: 'superadmin.errorPeriodModeRequired' }),
    }),
    period_months: z.string().trim().optional(),
    manual_until: z.string().trim().optional(),
  })
  .refine((data) => data.period_mode !== 'preset' || PERIOD_MONTHS.includes(data.period_months || ''), {
    message: 'superadmin.errorPeriodMonthsRequired',
    path: ['period_months'],
  })
  .refine((data) => data.period_mode !== 'manual' || DATE_ONLY_REGEX.test(data.manual_until || ''), {
    message: 'superadmin.errorManualUntilInvalid',
    path: ['manual_until'],
  });

module.exports = { extendSubscriptionSchema, PAYMENT_METHODS, PERIOD_MONTHS };
