const { z } = require('zod');
const { isCommonPassword } = require('../utils/commonPasswords');

const loginSchema = z.object({
  login: z.string().trim().min(1, 'login.errorEmptyFields'),
  password: z.string().min(1, 'login.errorEmptyFields'),
});

// login передаётся с фронта запроса (текущая сессия/найденный по токену админ), не из тела
// формы — иначе можно было бы обойти проверку "пароль не равен логину", подсунув другой login.
// bcrypt тихо обрезает вход длиннее 72 байт — тот же потолок, что и у admin_password
// в venueValidators.js, чтобы обрезанный "хвост" не оказался сюрпризом при следующем входе.
function buildNewPasswordSchema(login) {
  return z
    .string()
    .min(8, 'login.errorPasswordTooShort')
    .max(72, 'login.errorPasswordTooLong')
    .refine((v) => !login || v.toLowerCase() !== login.toLowerCase(), { message: 'login.errorPasswordMatchesLogin' })
    .refine((v) => !isCommonPassword(v), { message: 'login.errorPasswordTooCommon' });
}

function buildChangePasswordSchema(login) {
  return z.object({
    current_password: z.string().min(1, 'login.errorEmptyFields'),
    new_password: buildNewPasswordSchema(login),
  });
}

function buildResetPasswordSchema(login) {
  return z.object({
    new_password: buildNewPasswordSchema(login),
  });
}

const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(1, 'login.forgotErrorEmptyField'),
});

module.exports = {
  loginSchema,
  buildChangePasswordSchema,
  buildResetPasswordSchema,
  forgotPasswordSchema,
};
