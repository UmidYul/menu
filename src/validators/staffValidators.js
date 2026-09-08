const { z } = require('zod');

// Промт 3.5. Создание сотрудника заведения. Сообщения — КЛЮЧИ словаря, а не готовый текст.

const MAX_STAFF_PER_VENUE = 10;
const MIN_PASSWORD_LENGTH = 8;

// Логин — тот же формат, что и у остальных учёток проекта: он попадает в admins.login,
// где стоит UNIQUE на всю таблицу, а не на заведение. Поэтому подсказка в интерфейсе просит
// добавлять к имени что-то своё: «aziz_uyut», а не «aziz».
const loginField = z
  .string()
  .trim()
  .min(3, 'staff.errorLoginTooShort')
  .max(40, 'staff.errorLoginTooLong')
  .refine((v) => /^[a-z0-9_.-]+$/i.test(v), { message: 'staff.errorLoginFormat' });

const staffCreateSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, 'staff.errorNameEmpty')
    .max(80, 'staff.errorNameTooLong'),
  login: loginField,
  // Пароль необязателен: владелец может не задавать его вовсе и отправить сотруднику ссылку
  // быстрого входа, по которой тот придумает пароль сам. Пустое поле — это осознанный выбор,
  // а не пропуск, поэтому вместо ошибки просто ставим случайный (войти по нему нельзя,
  // никто его не увидит), а сотруднику остаётся ссылка.
  password: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .refine((v) => v === null || v.length >= MIN_PASSWORD_LENGTH, { message: 'staff.errorPasswordTooShort' }),
});

module.exports = { staffCreateSchema, MAX_STAFF_PER_VENUE, MIN_PASSWORD_LENGTH };
