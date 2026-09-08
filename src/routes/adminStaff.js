const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const env = require('../config/env');
const adminModel = require('../models/adminModel');
const passwordResetTokenModel = require('../models/passwordResetTokenModel');
const { logAction } = require('../models/adminActionLogModel');
const { generatePassword } = require('../utils/generatePassword');
const { staffCreateSchema, MAX_STAFF_PER_VENUE } = require('../validators/staffValidators');

// Управление сотрудниками — только владелец заведения. staff сюда не попадёт и по белому
// списку маршрутов (см. middlewares/staffAccess.js), но requireRole здесь стоит независимо:
// две несвязанные проверки лучше одной, если цена ошибки — чужой доступ к учёткам.
// venueStatusGate намеренно нет: у приостановленного заведения владелец должен иметь
// возможность хотя бы отключить сотрудников, а не упереться в редирект.
router.use(requireAuth, requireVenueRole(['owner']));

function venueId(req) {
  return req.session.admin.venueId;
}

async function renderList(req, res, { status, error, invite } = {}) {
  const [staff, activeCount] = await Promise.all([
    adminModel.listStaffByVenue(venueId(req)),
    adminModel.countActiveStaff(venueId(req)),
  ]);

  res.status(status || 200).render('admin/staff', {
    staff,
    activeCount,
    maxStaff: MAX_STAFF_PER_VENUE,
    // Ссылка быстрого входа показывается ровно один раз, сразу после генерации: в БД лежит
    // только её хеш, и восстановить её потом невозможно — как и пароль.
    invite: invite || null,
    error: error || null,
    login: req.session.admin.login,
    role: req.session.admin.role,
    venueSlug: req.session.admin.venueSlug,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await renderList(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const parsed = staffCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderList(req, res, { status: 422, error: t(parsed.error.issues[0].message) });
    }

    const activeCount = await adminModel.countActiveStaff(venueId(req));
    if (activeCount >= MAX_STAFF_PER_VENUE) {
      return renderList(req, res, { status: 422, error: t('staff.errorLimitReached', { max: MAX_STAFF_PER_VENUE }) });
    }

    // Пароля может не быть — тогда ставим случайный, который никто не узнает, и сотрудник
    // входит по ссылке (см. /invite ниже). Флаг must_change_password ставим в обоих случаях:
    // пароль, который владелец придумал за сотрудника, тот обязан сменить при первом входе.
    const password = parsed.data.password || generatePassword();
    const passwordHash = await bcrypt.hash(password, 10);

    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');
      created = await adminModel.create(client, {
        venueId: venueId(req),
        login: parsed.data.login,
        passwordHash,
        role: 'staff',
        mustChangePassword: true,
        displayName: parsed.data.display_name,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // Единственная ожидаемая здесь ошибка БД — занятый логин (UNIQUE на admins.login).
      // Показываем её понятным текстом, а не пятисоткой.
      if (err && err.code === '23505') {
        client.release();
        return renderList(req, res, { status: 422, error: t('staff.errorLoginTaken') });
      }
      client.release();
      throw err;
    }
    client.release();

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: venueId(req),
      actionType: 'create',
      entityType: 'admin',
      entityId: created.id,
      details: { login: created.login, display_name: created.display_name, role: 'staff' },
    });

    return res.redirect('/admin/staff');
  } catch (err) {
    return next(err);
  }
});

// Ссылка быстрого входа: одноразовая, живёт сутки. Владелец копирует её и отправляет сотруднику
// сам — Telegram официанта сервису неизвестен, и отправлять «за него» просто некуда.
router.post('/:id/invite', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const id = Number(req.params.id);
    const staff = Number.isInteger(id) ? await adminModel.findStaffForVenue(id, venueId(req)) : null;
    if (!staff) return renderList(req, res, { status: 404, error: t('staff.errorNotFound') });

    const rawToken = await passwordResetTokenModel.create(staff.id, {
      ttlMs: passwordResetTokenModel.STAFF_INVITE_TTL_MS,
    });

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: venueId(req),
      actionType: 'update',
      entityType: 'admin',
      entityId: staff.id,
      // Сам токен в журнал не пишем: журнал читают люди, и ссылка входа в нём — это лишний
      // способ войти под сотрудником для всех, у кого есть доступ к логам.
      details: { action: 'invite_link_issued', login: staff.login },
    });

    return renderList(req, res, {
      invite: {
        staffId: staff.id,
        name: staff.display_name || staff.login,
        url: `${env.APP_BASE_URL}/admin/reset?token=${rawToken}`,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// Увольнение — деактивация, а не удаление: admin_action_logs.admin_id стоит на ON DELETE
// RESTRICT именно затем, чтобы история действий осталась читаемой (edge case промта).
router.post('/:id/toggle-active', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const id = Number(req.params.id);
    const staff = Number.isInteger(id) ? await adminModel.findStaffForVenue(id, venueId(req)) : null;
    if (!staff) return renderList(req, res, { status: 404, error: t('staff.errorNotFound') });

    // Возвращая сотрудника в строй, снова упираемся в лимит: иначе через деактивацию
    // и включение можно было бы держать больше десяти действующих учёток.
    if (!staff.is_active) {
      const activeCount = await adminModel.countActiveStaff(venueId(req));
      if (activeCount >= MAX_STAFF_PER_VENUE) {
        return renderList(req, res, { status: 422, error: t('staff.errorLimitReached', { max: MAX_STAFF_PER_VENUE }) });
      }
    }

    const updated = await adminModel.setStaffActive(staff.id, venueId(req), !staff.is_active);
    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: venueId(req),
      actionType: 'update',
      entityType: 'admin',
      entityId: updated.id,
      details: { login: updated.login, is_active: updated.is_active },
    });

    return res.redirect('/admin/staff');
  } catch (err) {
    return next(err);
  }
});

// Сброс пароля: владелец задаёт новый временный пароль и показывает его сотруднику. Ссылка
// быстрого входа делает то же самое аккуратнее, но пароль на бумажке в подсобке — реальный
// сценарий в заведении, где у официанта нет Telegram.
router.post('/:id/reset-password', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const id = Number(req.params.id);
    const staff = Number.isInteger(id) ? await adminModel.findStaffForVenue(id, venueId(req)) : null;
    if (!staff) return renderList(req, res, { status: 404, error: t('staff.errorNotFound') });

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 10);
    await adminModel.resetStaffPassword(staff.id, venueId(req), passwordHash);

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: venueId(req),
      actionType: 'update',
      entityType: 'admin',
      entityId: staff.id,
      details: { action: 'password_reset', login: staff.login },
    });

    return renderList(req, res, {
      invite: {
        staffId: staff.id,
        name: staff.display_name || staff.login,
        password,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
