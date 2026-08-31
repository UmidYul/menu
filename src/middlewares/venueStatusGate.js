const { pool } = require('../config/db');

// Ограничивает доступ к категориям/позициям/настройкам заведения по venues.status (промт 1.3,
// раздел "Ограничения в админке"): suspended — редактирование целиком заблокировано, редирект
// на «Подписка»; archived — редирект на дашборд (там баннер "архивировано" + поддержка).
// Проверка всегда по свежему статусу из БД, а не из сессии — сессия живёт часами, а статус
// может смениться почасовым пересчётом (bot/worker/scheduler.js) в любой момент между запросами.
// Действует на все методы (не только GET) — иначе прямой POST в обход UI мог бы редактировать
// meню заведения, у которого по спеке "редактирование заблокировано".
async function venueStatusGate(req, res, next) {
  if (!req.session || !req.session.admin || req.session.admin.role !== 'venue_admin') return next();

  try {
    const result = await pool.query('SELECT status FROM venues WHERE id = $1', [req.session.admin.venueId]);
    const status = result.rows[0] && result.rows[0].status;

    if (status === 'suspended') {
      return res.redirect('/admin/subscription?blocked=suspended');
    }
    if (status === 'archived') {
      return res.redirect('/admin?blocked=archived');
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { venueStatusGate };
