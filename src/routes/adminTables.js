const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const { venueStatusGate } = require('../middlewares/venueStatusGate');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const venueTableModel = require('../models/venueTableModel');
const { logAction } = require('../models/adminActionLogModel');
const { tableNumberSchema, bulkCreateSchema, buildNumbers } = require('../validators/tableValidators');

router.use(requireAuth, requireVenueRole(['owner', 'manager']), venueStatusGate);

// Те же параметры, что и у QR заведения в adminDashboard.js — один и тот же визуальный код
// на столе и в кабинете, отличается только зашитая ссылка.
const QR_OPTIONS = { type: 'png', width: 480, margin: 1, color: { dark: '#27251f', light: '#fffdf8' } };

// ?src=qr — метка источника перехода для аналитики (промт 3.2), ?t=<token> — привязка к столу.
function tableMenuUrl(req, slug, token) {
  return `${req.protocol}://${req.get('host')}/menu/${slug}?t=${token}&src=qr`;
}

async function renderList(req, res, status, error, formValues) {
  const venueId = req.session.admin.venueId;
  const [venue, tables] = await Promise.all([
    venueModel.findById(venueId),
    venueTableModel.listByVenue(venueId),
  ]);

  res.status(status || 200).render('admin/tables', {
    venue,
    tables,
    error: error || null,
    formValues: formValues || { from: '', to: '', prefix: '' },
    query: req.query,
    login: req.session.admin.login,
    role: req.session.admin.role,
    venueSlug: venue.slug,
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
  try {
    const { t } = res.locals;
    const parsed = bulkCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderList(req, res, 422, t(parsed.error.issues[0].message), req.body);
    }

    const venueId = req.session.admin.venueId;
    const numbers = buildNumbers(parsed.data);
    const startSortOrder = (await venueTableModel.maxSortOrder(venueId)) + 1;
    const created = await venueTableModel.createMany(venueId, numbers, startSortOrder);

    // Ни одного не создано — значит все номера из диапазона уже заняты; это не ошибка формы,
    // но и молчать нельзя, иначе выглядит как «кнопка не сработала».
    if (created.length === 0) {
      return renderList(req, res, 200, t('tables.errorAllExist'), req.body);
    }

    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'create', entityType: 'table',
      entityId: created[0].id, details: { count: created.length, numbers: created.map((row) => row.number) },
    });

    res.redirect('/admin/tables');
  } catch (err) {
    next(err);
  }
});

// Загружает стол и проверяет принадлежность заведению прямо в SQL (не в шаблоне) — правило
// проекта для всех админских маршрутов.
async function loadOwnTableOr404(req, res) {
  const { t } = res.locals;
  const notFound = () => {
    res.status(404).render('errors/message', {
      title: t('tables.notFoundTitle'),
      message: t('tables.notFoundMessage'),
      backUrl: '/admin/tables',
    });
    return null;
  };

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return notFound();

  const table = await venueTableModel.findByIdForVenue(id, req.session.admin.venueId);
  if (!table) return notFound();
  return table;
}

router.post('/:id/rename', async (req, res, next) => {
  try {
    const table = await loadOwnTableOr404(req, res);
    if (!table) return undefined;

    const { t } = res.locals;
    const parsed = tableNumberSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderList(req, res, 422, t(parsed.error.issues[0].message));
    }

    const venueId = req.session.admin.venueId;
    let updated;
    try {
      updated = await venueTableModel.rename(table.id, venueId, parsed.data.number);
    } catch (err) {
      // Нарушение UNIQUE (venue_id, number) — понятный текст вместо 500.
      if (err.code === '23505') return renderList(req, res, 422, t('tables.errorNumberTaken'));
      throw err;
    }

    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'table',
      entityId: table.id, details: { before: table.number, after: updated.number },
    });

    return res.redirect('/admin/tables');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/toggle', async (req, res, next) => {
  try {
    const table = await loadOwnTableOr404(req, res);
    if (!table) return undefined;

    const venueId = req.session.admin.venueId;
    const updated = await venueTableModel.toggleActive(table.id, venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'table',
      entityId: table.id, details: { field: 'is_active', value: updated.is_active },
    });
    return res.redirect('/admin/tables');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/regenerate', async (req, res, next) => {
  try {
    const table = await loadOwnTableOr404(req, res);
    if (!table) return undefined;

    const venueId = req.session.admin.venueId;
    await venueTableModel.regenerateToken(table.id, venueId);
    // Сам токен в журнал не пишем — это секрет, по которому идентифицируется стол.
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'table',
      entityId: table.id, details: { field: 'token', regenerated: true, number: table.number },
    });
    return res.redirect('/admin/tables?regenerated=' + table.id);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const table = await loadOwnTableOr404(req, res);
    if (!table) return undefined;

    const venueId = req.session.admin.venueId;
    await venueTableModel.remove(table.id, venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'delete', entityType: 'table',
      entityId: table.id, details: { number: table.number },
    });
    return res.redirect('/admin/tables');
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/qr.png', async (req, res, next) => {
  try {
    const table = await loadOwnTableOr404(req, res);
    if (!table) return undefined;

    const venue = await venueModel.findById(req.session.admin.venueId);
    const buffer = await QRCode.toBuffer(tableMenuUrl(req, venue.slug, table.token), QR_OPTIONS);

    if (req.query.download === '1') {
      // Номер стола может содержать пробелы/кириллицу — в filename оставляем только безопасное,
      // иначе заголовок придётся кодировать по RFC 5987 ради очень небольшой пользы.
      const safeNumber = String(table.number).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || String(table.id);
      res.set('Content-Disposition', `attachment; filename="table-${safeNumber}-qr.png"`);
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

// Лист для печати: все активные столы сеткой, QR встроены как data: URI. Отдельной библиотеки
// для ZIP/PDF не заводим — «скачать все» здесь это печать страницы браузером (в том числе
// «сохранить как PDF»), что покрывает и распечатать, и сохранить файлом.
router.get('/print', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const [venue, tables] = await Promise.all([
      venueModel.findById(venueId),
      venueTableModel.listByVenue(venueId),
    ]);

    const active = tables.filter((table) => table.is_active);
    const withQr = await Promise.all(active.map(async (table) => ({
      ...table,
      qrDataUrl: await QRCode.toDataURL(tableMenuUrl(req, venue.slug, table.token), QR_OPTIONS),
    })));

    res.render('admin/tables-print', { venue, tables: withQr });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
