const express = require('express');
const bcrypt = require('bcrypt');

const router = express.Router();
const adminModel = require('../models/adminModel');
const adminVenueModel = require('../models/adminVenueModel');
const venueModel = require('../models/venueModel');
const passwordResetTokenModel = require('../models/passwordResetTokenModel');
const notificationModel = require('../models/notificationModel');
const { logAction } = require('../models/adminActionLogModel');
const venueLifecycle = require('../services/venueLifecycle');
const { applyNewPassword } = require('../services/passwordChange');
const { loginSchema, forgotPasswordSchema, buildResetPasswordSchema } = require('../validators/authValidators');
const {
  loginLimiter, loginByAccountLimiter, forgotPasswordIpLimiter, forgotPasswordAccountLimiter,
} = require('../middlewares/rateLimit');
const { requireAuth } = require('../middlewares/auth');
const { hashIp } = require('../utils/hashIp');
const { pool } = require('../config/db');
const env = require('../config/env');

// Хеш-заглушка для bcrypt.compare, когда логин не найден — без неё ветка "нет такого админа"
// возвращается сразу, а ветка "админ есть, пароль неверный" всегда ждёт полный bcrypt.compare
// (~десятки мс). Разница во времени ответа позволяет перебором логинов узнавать, какие из них
// вообще существуют, даже не подбирая пароль. Сравнение с заглушкой всегда занимает то же время,
// что и сравнение с настоящим хешем той же стоимости, — веток с разным таймингом не остаётся.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing-equalization', 10);

// Порог для доп. задержки ответа и для алерта владельцу — счётчик admins.failed_login_count
// растёт только для НАЙДЕННЫХ логинов (см. коммент у DUMMY_PASSWORD_HASH: несуществующему
// логину и так нечего замедлять — за него уже отвечают IP- и login-лимитеры ниже, а собственная
// задержка задним числом выдала бы, что аккаунт вообще-то есть).
const DELAY_AFTER_FAILURES = 5;
const NOTIFY_OWNER_AFTER_FAILURES = 10;
const FAILURE_DELAY_MS = 2000;

router.get('/login', (req, res) => {
  if (req.session && req.session.admin) {
    return res.redirect('/admin');
  }
  const { t } = res.locals;
  const success = req.query.reset === '1' ? t('login.resetSuccessMessage') : null;
  res.render('admin/login', { error: null, login: '', success });
});

router.post('/login', loginLimiter, loginByAccountLimiter, async (req, res, next) => {
  const { t } = res.locals;
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('admin/login', {
        error: t('login.errorEmptyFields'),
        login: typeof req.body.login === 'string' ? req.body.login : '',
      });
    }
    const { login, password } = parsed.data;

    const admin = await adminModel.findByLogin(login);
    const passwordMatches = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_PASSWORD_HASH);

    if (!admin || !passwordMatches) {
      if (admin) {
        const failCount = await adminModel.incrementFailedLogin(admin.id);
        await logAction(pool, {
          adminId: admin.id,
          venueId: admin.venue_id,
          actionType: 'auth_fail',
          entityType: 'admin',
          entityId: admin.id,
          details: { ip_hash: hashIp(req.ip) },
        });

        if (failCount === NOTIFY_OWNER_AFTER_FAILURES && admin.role !== 'superadmin' && admin.venue_id) {
          const venue = await venueModel.findById(admin.venue_id);
          if (venue) {
            await venueLifecycle.notifyVenue(pool, venue, {
              template: 'admin_ten_failed_logins',
              payload: { venue_name: venue.name },
              dedupKey: null,
            });
          }
        }

        if (failCount >= DELAY_AFTER_FAILURES) {
          await new Promise((resolve) => { setTimeout(resolve, FAILURE_DELAY_MS); });
        }
      }

      return res.status(401).render('admin/login', {
        error: t('login.errorInvalidCredentials'),
        login,
      });
    }

    if (admin.failed_login_count > 0) {
      await adminModel.resetFailedLogin(admin.id);
    }

    if (admin.is_active === false) {
      return res.status(403).render('admin/login', {
        error: t('login.errorAccountDisabled'),
        login,
      });
    }

    // Промт 3.6. Доступ к заведениям берётся из admin_venues, а не из устаревшей admins.venue_id.
    // Заведений может быть несколько — активным становится первое, а дальше решает переключатель
    // (см. middlewares/activeVenue.js: он же на каждый запрос перепроверяет доступ).
    const venues = admin.role === 'superadmin' ? [] : await adminVenueModel.listForAdmin(admin.id);
    const firstVenue = venues[0] || null;

    // Edge case промта 3.6: администратор без единого заведения. Впустить его можно — понятную
    // страницу покажет resolveActiveVenue; отказывать во входе неверно, иначе человек не сможет
    // ни сменить пароль, ни выйти.
    if (admin.role !== 'superadmin' && firstVenue && firstVenue.is_active === false) {
      return res.status(403).render('admin/login', {
        error: t('login.errorVenueDisabled'),
        login,
      });
    }

    // Промт 3.5, edge case: заведение в suspended — вход персонала запрещён с понятным
    // сообщением. Владелец при этом входить обязан: приостановка снимается оплатой, а оплатить
    // он может только изнутри кабинета.
    // Промт 3.6: «персонал» определяется ролью в заведении, а не типом аккаунта, — и проверять
    // надо ВСЕ доступные заведения: если человек только staff и все его точки приостановлены,
    // делать ему внутри нечего, а если хоть где-то он owner или manager — пускаем.
    const hasUsableVenue = venues.some((venue) => (
      venue.role !== 'staff' || (venue.status !== 'suspended' && venue.status !== 'archived')
    ));
    if (admin.role !== 'superadmin' && venues.length > 0 && !hasUsableVenue) {
      return res.status(403).render('admin/login', {
        error: t('login.errorStaffVenueSuspended'),
        login,
      });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.admin = {
        id: admin.id,
        login: admin.login,
        // Промт 3.5: в зале человека зовут по имени, а не по логину — «выключил Азиз, 14:20».
        displayName: admin.display_name || null,
        role: admin.role,
        // Промт 3.6: venueId — АКТИВНОЕ заведение, а не единственное. Полный список и роль
        // в активном выставляет resolveActiveVenue на каждый запрос по свежим данным из БД.
        venueId: firstVenue ? firstVenue.id : null,
        venueSlug: firstVenue ? firstVenue.slug : null,
        venueRole: firstVenue ? firstVenue.role : null,
        mustChangePassword: admin.must_change_password === true,
      };

      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        if (admin.role === 'superadmin') {
          return res.redirect('/superadmin/venues');
        }
        if (admin.must_change_password) {
          return res.redirect('/admin/password');
        }
        // Официанту в общем кабинете делать нечего — он туда и не пройдёт (белый список
        // маршрутов), поэтому сразу отправляем на его единственный рабочий экран.
        // Роль берётся из активного заведения (промт 3.6), а не из типа аккаунта.
        if (firstVenue && firstVenue.role === 'staff') {
          return res.redirect('/admin/stoplist');
        }
        return res.redirect('/admin');
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('qrmenu.sid');
    res.redirect('/admin/login');
  });
});

router.get('/forgot', (req, res) => {
  res.render('admin/forgot', {
    submitted: false, error: null, identifier: '', botLink: env.BOT_USERNAME ? `https://t.me/${env.BOT_USERNAME}` : null,
  });
});

router.post('/forgot', forgotPasswordIpLimiter, forgotPasswordAccountLimiter, async (req, res, next) => {
  const { t } = res.locals;
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('admin/forgot', {
        submitted: false,
        error: t(parsed.error.issues[0].message),
        botLink: env.BOT_USERNAME ? `https://t.me/${env.BOT_USERNAME}` : null,
        identifier: typeof req.body.identifier === 'string' ? req.body.identifier : '',
      });
    }

    // Ответ ВСЕГДА одинаковый ниже, независимо от исхода — иначе форма сама превращается
    // в способ проверить, какие логины/email существуют (промт 1.5, п.3).
    const admin = await adminModel.findByEmailOrLogin(parsed.data.identifier);
    if (admin && admin.email) {
      const rawToken = await passwordResetTokenModel.create(admin.id, { requestedIpHash: hashIp(req.ip) });
      const resetUrl = `${env.APP_BASE_URL}/admin/reset?token=${rawToken}`;
      const payload = { admin_login: admin.login, reset_url: resetUrl };

      // Оба канала, если оба есть — это восстановление доступа, а не рядовое уведомление:
      // лучше показать ссылку дважды, чем один раз, но не туда, где сейчас смотрит человек.
      if (admin.telegram_id) {
        await notificationModel.enqueue(null, {
          channel: 'telegram', recipient: String(admin.telegram_id), template: 'password_reset_link', payload, lang: 'ru',
        });
      }
      await notificationModel.enqueue(null, {
        channel: 'email', recipient: admin.email, template: 'password_reset_link', payload, lang: 'ru',
      });
    }

    res.render('admin/forgot', { submitted: true, error: null, identifier: '' });
  } catch (err) {
    next(err);
  }
});

router.get('/reset', async (req, res, next) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const record = token ? await passwordResetTokenModel.findValidByRawToken(token) : null;
    res.render('admin/reset', { valid: Boolean(record), token, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/reset', async (req, res, next) => {
  const { t } = res.locals;
  try {
    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const record = token ? await passwordResetTokenModel.findValidByRawToken(token) : null;
    if (!record) {
      return res.render('admin/reset', { valid: false, token, error: null });
    }

    const admin = await adminModel.findById(record.admin_id);
    if (!admin) {
      return res.render('admin/reset', { valid: false, token, error: null });
    }

    const parsed = buildResetPasswordSchema(admin.login).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).render('admin/reset', {
        valid: true,
        token,
        error: t(parsed.error.issues[0].message),
      });
    }

    // Атомарный "забор" токена — гасит гонку двойного использования одной и той же ссылки
    // (edge case промта 1.5). Если параллельный запрос уже забрал его между GET и этим POST —
    // здесь claim вернёт null, и это тот же экран "ссылка недействительна", что и всегда.
    const claimed = await passwordResetTokenModel.claimToken(token);
    if (!claimed) {
      return res.render('admin/reset', { valid: false, token, error: null });
    }

    await applyNewPassword(admin, parsed.data.new_password, {});
    res.redirect('/admin/login?reset=1');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
