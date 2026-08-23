const { z } = require('zod');

const slugRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const createVenueSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1, 'Введите slug')
    .regex(slugRegex, 'Slug может содержать только строчные латинские буквы, цифры и дефис (без пробелов и подряд идущих дефисов)'),
  name: z.string().trim().min(1, 'Введите название заведения'),
  lang_default: z.enum(['ru', 'uz'], {
    errorMap: () => ({ message: 'Выберите язык по умолчанию' }),
  }),
  admin_login: z.string().trim().min(3, 'Логин администратора должен быть не короче 3 символов'),
  admin_password: z.string().min(6, 'Пароль администратора должен быть не короче 6 символов'),
});

module.exports = { createVenueSchema };
