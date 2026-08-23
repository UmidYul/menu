const { z } = require('zod');

const staffSchema = z.object({
  login: z.string().trim().min(3, 'staff.errorLoginTooShort'),
  password: z.string().min(6, 'staff.errorPasswordTooShort'),
});

module.exports = { staffSchema };
