const nodemailer = require('nodemailer');
const env = require('../config/env');

// null, если SMTP не сконфигурирован — send() тогда просто логирует и не падает. Локальная
// разработка не должна требовать поднятого SMTP-сервера.
const transporter = env.smtpConfigured
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

async function send({ to, subject, html, text }) {
  if (!transporter) {
    console.warn(`mailer: SMTP не настроен, письмо "${subject}" для ${to} не отправлено`);
    return { skipped: true };
  }

  await transporter.sendMail({
    from: `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM}>`,
    to,
    subject,
    html,
    text,
  });
  return { skipped: false };
}

module.exports = { send };
