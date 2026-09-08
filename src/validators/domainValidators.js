const { z } = require('zod');
const env = require('../config/env');
const { normalizeDomain, stripWww } = require('../utils/domainName');

// Промт 3.7. Сообщения — КЛЮЧИ словаря, не текст (правило проекта): язык знает шаблон,
// а не валидатор.
//
// Вся содержательная проверка здесь одна: normalizeDomain либо приводит ввод к каноническому
// виду, либо говорит «это не домен». Держать рядом с ней вторую регулярку «на всякий случай»
// значило бы завести два несогласуемых представления о том, что такое домен.
const domainSchema = z.object({
  domain: z
    .string({ required_error: 'domains.errorInvalid' })
    .trim()
    .min(1, 'domains.errorInvalid')
    // Потолок до нормализации: punycode длиннее исходной кириллицы, но не в разы, а гигантскую
    // строку не стоит и пытаться разбирать.
    .max(400, 'domains.errorInvalid')
    .transform((value) => normalizeDomain(value))
    // superRefine, а не две .refine подряд: zod прогоняет ВСЕ звенья цепочки, даже когда
    // предыдущее уже забраковало значение, — и вторая проверка получала бы null от
    // normalizeDomain. Здесь порядок явный, с выходом после первой же неудачи.
    .superRefine((value, ctx) => {
      if (value === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'domains.errorInvalid' });
        return;
      }
      // Собственный адрес сервиса подключить нельзя: заведение, добавившее qr.menu,
      // перехватило бы весь сервис на себя. Сравнение без www — www.qr.menu это тот же сервис.
      const own = (env.SERVICE_HOST || '').split(':')[0].toLowerCase();
      if (own && stripWww(value) === stripWww(own)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'domains.errorServiceHost' });
      }
    }),
  // Галочка «заодно подключить www» — необязательная.
  with_www: z.any().optional(),
});

module.exports = { domainSchema };
