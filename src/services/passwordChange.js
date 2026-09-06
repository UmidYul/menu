const bcrypt = require('bcrypt');
const { pool } = require('../config/db');
const adminModel = require('../models/adminModel');
const notificationModel = require('../models/notificationModel');
const { logAction } = require('../models/adminActionLogModel');

// Общий финальный шаг для обеих веток промта 1.5 — обычной смены пароля (текущий пароль уже
// подтверждён вызывающим роутом) и восстановления по токену (личность подтвердил сам токен).
// currentSessionId — sid активной сессии, которую НЕ трогаем (её нет при восстановлении по
// токену, там пользователь ещё не залогинен нигде, и глушатся вообще все существующие сессии).
async function applyNewPassword(admin, newPassword, { currentSessionId } = {}) {
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await adminModel.updatePassword(admin.id, passwordHash);

  // connect-pg-simple хранит сессии в user_sessions, данные — в json-колонке sess без отдельной
  // колонки admin_id, поэтому "удали все остальные сессии этого админа" — это выборка по
  // sess->'admin'->>'id'. ->>  всегда отдаёт text, сравниваем с id как со строкой.
  if (currentSessionId) {
    await pool.query('DELETE FROM user_sessions WHERE sess->\'admin\'->>\'id\' = $1 AND sid != $2', [
      String(admin.id), currentSessionId,
    ]);
  } else {
    await pool.query('DELETE FROM user_sessions WHERE sess->\'admin\'->>\'id\' = $1', [String(admin.id)]);
  }

  await logAction(pool, {
    adminId: admin.id,
    venueId: admin.venue_id,
    actionType: 'update',
    entityType: 'admin',
    entityId: admin.id,
    details: { action: 'password_changed' },
  });

  const payload = { admin_login: admin.login };
  if (admin.telegram_id) {
    await notificationModel.enqueue(null, {
      channel: 'telegram', recipient: String(admin.telegram_id), template: 'admin_password_changed', payload, lang: 'ru',
    });
  }
  if (admin.email) {
    await notificationModel.enqueue(null, {
      channel: 'email', recipient: admin.email, template: 'admin_password_changed', payload, lang: 'ru',
    });
  }
}

module.exports = { applyNewPassword };
