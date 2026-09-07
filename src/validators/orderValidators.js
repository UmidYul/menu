const { z } = require('zod');

// Пустая строка = «минимальная сумма не задана» (промт 2.4: «по умолчанию не задана»),
// поэтому именно '' -> null, а не 0: ноль как минимум означал бы «любой заказ проходит»,
// но хранить его отдельно от NULL незачем, а форма должна уметь снять ограничение.
const minOrderAmountSchema = z.object({
  min_order_amount: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : v))
    .refine((v) => v === null || /^\d+(\.\d{1,2})?$/.test(v), { message: 'ordersSettings.errorMinAmountInvalid' })
    .transform((v) => (v === null ? null : Number(v)))
    .refine((v) => v === null || v > 0, { message: 'ordersSettings.errorMinAmountInvalid' }),
});

const MAX_ORDER_LINES = 50;
const MAX_QTY_PER_LINE = 99;
const MAX_COMMENT_LENGTH = 500;
const MAX_TABLE_NUMBER_LENGTH = 40;

// Тело заказа от гостя. Цены СЮДА НЕ ВХОДЯТ намеренно: сервер считает сумму сам по актуальному
// меню (промт 2.4), клиент присылает только expectedTotal — то, что он показал гостю, чтобы
// сервер мог заметить расхождение и не отправить заказ молча по другой цене.
const orderSubmitSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        qty: z.number().int().min(1).max(MAX_QTY_PER_LINE),
        optionIds: z.array(z.number().int().positive()).max(20).optional().default([]),
      })
    )
    .min(1)
    .max(MAX_ORDER_LINES),
  expectedTotal: z.number().nonnegative(),
  comment: z.string().trim().max(MAX_COMMENT_LENGTH).optional().transform((v) => v || null),
  // Нужен, только если стол не определился по QR-токену — тогда гость вводит его руками.
  tableNumber: z.string().trim().max(MAX_TABLE_NUMBER_LENGTH).optional().transform((v) => v || null),
});

const waiterCallSchema = z.object({
  callType: z.enum(['come', 'bill', 'cutlery']),
});

module.exports = {
  minOrderAmountSchema,
  orderSubmitSchema,
  waiterCallSchema,
  MAX_ORDER_LINES,
  MAX_COMMENT_LENGTH,
};
