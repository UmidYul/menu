const express = require('express');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const { venueStatusGate } = require('../middlewares/venueStatusGate');
const { pool } = require('../config/db');
const waiterCallModel = require('../models/waiterCallModel');
const venueModel = require('../models/venueModel');
const { logAction } = require('../models/adminActionLogModel');

router.use(requireAuth, requireVenueRole(['owner', 'manager', 'staff']), venueStatusGate);

// Промт 3.5: вызовы официанта staff видит, «если включены заказы». Условие проверяется здесь,
// а не в белом списке маршрутов: список решает «доступен ли маршрут роли», а «включена ли
// функция у заведения» — вопрос данных, и ответ на него меняется без перелогина.
const CALLS_WINDOW_MS = 12 * 60 * 60 * 1000;

function venueId(req) {
  return req.session.admin.venueId;
}

async function loadVenueOrDisabled(req, res) {
  const venue = await venueModel.findById(venueId(req));
  if (!venue) return null;
  const ordersEnabled = Boolean(venue.orders_enabled && venue.telegram_chat_id && !venue.telegram_chat_broken);
  return { venue, ordersEnabled };
}

router.get('/', async (req, res, next) => {
  try {
    const loaded = await loadVenueOrDisabled(req, res);
    if (!loaded) return res.status(404).render('errors/403');

    const calls = loaded.ordersEnabled
      ? await waiterCallModel.listRecentByVenue(venueId(req), { withinMs: CALLS_WINDOW_MS })
      : [];

    return res.render('admin/calls', {
      calls,
      ordersEnabled: loaded.ordersEnabled,
      venueName: loaded.venue.name,
      login: req.session.admin.login,
      displayName: req.session.admin.displayName || req.session.admin.login,
      role: req.session.admin.role,
    });
  } catch (err) {
    return next(err);
  }
});

// Опрос свежих вызовов: экран официанта открыт в зале, и новый вызов должен появиться сам,
// без перезагрузки. Отдельный лёгкий JSON вместо перерисовки страницы целиком.
router.get('/state', async (req, res, next) => {
  try {
    const loaded = await loadVenueOrDisabled(req, res);
    if (!loaded || !loaded.ordersEnabled) return res.json({ calls: [] });

    const calls = await waiterCallModel.listRecentByVenue(venueId(req), { withinMs: CALLS_WINDOW_MS });
    res.set('Cache-Control', 'no-store');
    return res.json({
      calls: calls.map((call) => ({
        id: call.id,
        tableNumber: call.table_number_snapshot,
        callType: call.call_type,
        status: call.status,
        createdAt: call.created_at,
        acknowledgedByName: call.acknowledged_by_name,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/ack', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_request' });

    const updated = await waiterCallModel.markAcknowledgedByAdmin(id, venueId(req), req.session.admin.id);
    if (!updated) {
      // markAcknowledgedByAdmin возвращает null в двух разных случаях, и различать их важно.
      // Данные защищены в обоих (venue_id стоит в WHERE самого UPDATE), но ответ должен быть
      // честным: «уже приняли» — не ошибка, а «вызов не твой» — именно отказ.
      // Проверка эмпирическая (scripts/check-idor.js) поймала ровно это: чужой id отдавал 200.
      const own = await waiterCallModel.findByIdForVenue(id, venueId(req));
      if (!own) return res.status(404).json({ error: 'not_found' });
      // Свой вызов, уже принятый где-то ещё — в группе или на другом телефоне.
      return res.json({ ok: false, already: true });
    }

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: venueId(req),
      actionType: 'update',
      entityType: 'waiter_call',
      entityId: updated.id,
      details: { status: 'acknowledged', source: 'web' },
    });

    return res.json({
      ok: true,
      id: updated.id,
      acknowledgedByName: req.session.admin.displayName || req.session.admin.login,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
