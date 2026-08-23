const { z } = require('zod');

const slugRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const createVenueSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1, 'superadmin.errorSlugRequired')
    .regex(slugRegex, 'superadmin.errorSlugFormat'),
  name: z.string().trim().min(1, 'superadmin.errorNameRequired'),
  lang_default: z.enum(['ru', 'uz'], {
    errorMap: () => ({ message: 'superadmin.errorLangRequired' }),
  }),
  admin_login: z.string().trim().min(3, 'superadmin.errorAdminLoginTooShort'),
  admin_password: z.string().min(6, 'superadmin.errorAdminPasswordTooShort'),
});

module.exports = { createVenueSchema };
