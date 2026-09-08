const { z } = require('zod');
const { timeToSeconds, normalizeInterval, secondsToTime } = require('../services/availability');

// Промт 2.3. Формы расписания: набор дней недели чекбоксами + время начала и конца.
// Сообщения — КЛЮЧИ словаря, а не готовый текст (правило проекта).

const ISO_WEEKDAYS = ['1', '2', '3', '4', '5', '6', '7'];
const HIDDEN_MODES = ['hide', 'dim', 'section'];

// Чекбоксы приходят массивом, одной строкой или не приходят вовсе — тот же приём, что и у
// тегов/аллергенов в itemValidators.js.
const daysField = z
  .union([z.array(z.string()), z.string(), z.undefined()])
  .transform((val) => {
    if (val === undefined) return [];
    return Array.isArray(val) ? val : [val];
  })
  .refine((values) => values.length > 0, { message: 'schedules.errorNoDays' })
  .refine((values) => values.every((v) => ISO_WEEKDAYS.includes(v)), { message: 'schedules.errorBadDay' })
  // Дубликаты из подделанной формы убираем молча — на смысл они не влияют, а массив в БД
  // должен остаться чистым.
  .transform((values) => Array.from(new Set(values.map(Number))).sort((a, b) => a - b));

const timeField = z
  .string({ required_error: 'schedules.errorBadTime' })
  .trim()
  .refine((v) => timeToSeconds(v) !== null, { message: 'schedules.errorBadTime' });

const scheduleRuleSchema = z
  .object({
    days: daysField,
    time_from: timeField,
    time_to: timeField,
  })
  // Нормализация «почти сутки» (00:00–23:59 и любой другой интервал, кончающийся ровно за
  // минуту до начала) в ровно сутки — здесь, при сохранении, а не в сравнении на границе:
  // подробности в services/availability.js:normalizeInterval.
  .transform((data) => {
    const interval = normalizeInterval(timeToSeconds(data.time_from), timeToSeconds(data.time_to));
    return {
      days: data.days,
      time_from: secondsToTime(interval.from),
      time_to: secondsToTime(interval.to),
    };
  });

// Режим показа того, что сейчас вне расписания — настройка категории.
const hiddenModeField = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : 'dim'))
  .refine((v) => HIDDEN_MODES.includes(v), { message: 'schedules.errorBadMode' });

// Часовой пояс заведения (суперадминка). Проверяем через сам Intl, а не списком в коде:
// список зон живёт в ICU и обновляется вместе с ним.
const timezoneField = z
  .string()
  .trim()
  .min(1, 'schedules.errorBadTimezone')
  .refine((v) => {
    try {
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat('en-GB', { timeZone: v });
      return true;
    } catch (err) {
      return false;
    }
  }, { message: 'schedules.errorBadTimezone' });

const venueTimezoneSchema = z.object({ timezone: timezoneField });

module.exports = {
  ISO_WEEKDAYS,
  HIDDEN_MODES,
  scheduleRuleSchema,
  hiddenModeField,
  venueTimezoneSchema,
};
