const bcrypt = require('bcrypt');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const adminModel = require('../models/adminModel');
const leadModel = require('../models/leadModel');
const notificationModel = require('../models/notificationModel');
const { logAction } = require('../models/adminActionLogModel');
const { generatePassword } = require('../utils/generatePassword');

// Логин-кандидат из телефона заявки (9 цифр без +998) — если занят, добавляет суффикс.
// Коллизии на практике редки (разные заявители — разные номера), пары попыток достаточно.
async function generateAdminLogin(phone) {
  const digits = phone.replace(/\D/g, '').slice(-9);
  let candidate = digits;
  let attempt = 1;
  while (await adminModel.findByLogin(candidate)) {
    attempt += 1;
    candidate = `${digits}${attempt}`;
  }
  return candidate;
}

// Значения по умолчанию для формы одобрения — и для быстрого одобрения из бота "как есть",
// и как предзаполнение формы в суперадминке, где их можно поправить перед подтверждением.
async function buildApprovalDefaults(lead) {
  const [slug, adminLogin] = await Promise.all([
    leadModel.generateUniqueSlug(lead.venue_name),
    generateAdminLogin(lead.phone),
  ]);
  return {
    slug,
    name: lead.venue_name,
    langDefault: 'ru',
    adminLogin,
    adminPassword: generatePassword(),
  };
}

// Общий путь одобрения — вызывается и из бота (промт 1.2, быстрое одобрение с автозначениями),
// и из /superadmin/leads (после правки суперадмином). Venue создаётся в статусе 'draft' и
// is_active:false — до промта 1.3 нет отдельной страницы-заглушки для draft, is_active:false
// временно отдаёт уже существующую "меню недоступно" для только что созданных заведений.
// processedBy — admin_id суперадмина при одобрении через веб, null при быстром одобрении из
// бота (там нет привязки Telegram к конкретному admins-аккаунту — это промт 1.5).
async function approveLead(lead, { slug, name, langDefault, adminLogin, adminPassword, processedBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const venue = await venueModel.create(client, {
      slug, name, langDefault: langDefault || 'ru', status: 'draft', isActive: false,
    });
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const admin = await adminModel.create(client, {
      venueId: venue.id,
      login: adminLogin,
      passwordHash,
      role: 'venue_admin',
    });

    await leadModel.markApproved(client, lead.id, { venueId: venue.id, processedBy: processedBy || null });

    await logAction(client, {
      adminId: processedBy || null,
      venueId: venue.id,
      actionType: 'create',
      entityType: 'venue',
      entityId: venue.id,
      details: { slug: venue.slug, name: venue.name, admin_login: admin.login, from_lead_id: lead.id },
    });
    await logAction(client, {
      adminId: processedBy || null,
      venueId: venue.id,
      actionType: 'update',
      entityType: 'lead',
      entityId: lead.id,
      details: { status: 'approved', venue_id: venue.id },
    });

    // Логин/пароль уходят одним уведомлением — без разбивки на два сообщения, это конкретно
    // защита промта 1.5 вместе с must_change_password, которого пока нет.
    const payload = { venue_name: venue.name, admin_login: adminLogin, admin_password: adminPassword };
    if (lead.telegram_id) {
      await notificationModel.enqueue(client, {
        channel: 'telegram', recipient: String(lead.telegram_id), template: 'lead_approved', payload, lang: 'ru',
      });
    } else if (lead.email) {
      await notificationModel.enqueue(client, {
        channel: 'email', recipient: lead.email, template: 'lead_approved', payload, lang: 'ru',
      });
    }

    await client.query('COMMIT');
    return { venue, admin };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Тоже общий путь — бот (кнопка "Отклонить" + причина следующим сообщением) и суперадминка
// (форма с обязательной причиной) заканчиваются здесь одинаково.
async function rejectLead(lead, { reason, processedBy }) {
  const updated = await leadModel.markRejected(lead.id, { reason, processedBy: processedBy || null });

  await logAction(pool, {
    adminId: processedBy || null,
    venueId: null,
    actionType: 'update',
    entityType: 'lead',
    entityId: lead.id,
    details: { status: 'rejected', reject_reason: reason },
  });

  const payload = { venue_name: lead.venue_name, reason };
  if (lead.telegram_id) {
    await notificationModel.enqueue(pool, {
      channel: 'telegram', recipient: String(lead.telegram_id), template: 'lead_rejected', payload, lang: 'ru',
    });
  } else if (lead.email) {
    await notificationModel.enqueue(pool, {
      channel: 'email', recipient: lead.email, template: 'lead_rejected', payload, lang: 'ru',
    });
  }

  return updated;
}

module.exports = { buildApprovalDefaults, approveLead, rejectLead, generateAdminLogin };
