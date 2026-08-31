const { z } = require('zod');

const CLAIM_MONTHS = [1, 3, 6, 12];

const claimSchema = z.object({
  months: z.coerce
    .number({ invalid_type_error: 'subscription.errorMonthsRequired' })
    .refine((v) => CLAIM_MONTHS.includes(v), { message: 'subscription.errorMonthsRequired' }),
  payer_note: z.string().trim().max(500, 'subscription.errorCommentTooLong').optional().transform((v) => v || null),
});

const claimRejectSchema = z.object({
  reason: z.string().trim().min(1, 'superadmin.errorRejectReasonRequired').max(500, 'superadmin.errorTooLong'),
});

module.exports = { CLAIM_MONTHS, claimSchema, claimRejectSchema };
