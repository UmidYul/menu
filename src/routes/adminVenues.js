const express = require('express');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const adminVenueModel = require('../models/adminVenueModel');
const venuePageViewModel = require('../models/venuePageViewModel');
const menuCopy = require('../services/menuCopy');
const pgNotify = require('../services/pgNotify');
const { computeSubscriptionStatus } = require('../utils/subscriptionStatus');

// Промт 3.6, разделы 4 и 5: сводный экран сети и копирование меню.
//
// Экран имеет смысл только при двух и более заведениях — при одном он показывал бы таблицу
// из одной строки и предлагал копировать меню неоткуда. Пункт в меню при одном заведении
// не рисуется (см. partials/admin-sidebar.ejs), а сам маршрут отвечает 404: скрытая ссылка —
// это подсказка интерфейса, а не проверка доступа.
//
// staff сюда не попадает вовсе: маршрута нет в белом списке middlewares/staffAccess.js.
router.use(requireAuth, requireVenueRole(['owner', 'manager']));

function requireNetwork(req, res, next) {
  const venues = (req.session.admin && req.session.admin.venues) || [];
  if (venues.length >= 2) return next();

  // Не голый 404: сюда приходят по закладке, оставшейся с тех пор, когда заведений было
  // больше, — и человеку полезнее знать, почему экрана нет, чем увидеть «не найдено».
  const { t } = res.locals;
  return res.status(404).render('errors/message', {
    title: t('venues.singleVenueTitle'),
    message: t('venues.singleVenueMessage'),
    backUrl: '/admin',
  });
}

// Разбор параметров копирования — один на предпросмотр (GET) и на само копирование (POST),
// чтобы предпросмотр не мог показать одно, а копирование сделать другое.
// Возвращает { sourceVenueId, withPhotos, withPrices } или { errorKey }.
async function parseCopyParams(req) {
  // Предпросмотр приходит GET-ом (параметры в адресе), копирование — POST-ом (в теле).
  // Читаем из одного объединённого объекта, чтобы обе ветви разбирались одним и тем же кодом
  // и не могли разойтись. Тело приоритетнее адреса: у POST-а адрес пустой.
  const raw = { ...req.query, ...req.body };
  const source = Number(raw.source_venue_id);
  // 'on' — то, что шлёт незаполненный value у чекбокса; '1' — наш явный value и скрытые поля
  // формы подтверждения.
  const withPhotos = raw.with_photos === '1' || raw.with_photos === 'on';
  const withPrices = raw.with_prices === '1' || raw.with_prices === 'on';

  if (!Number.isInteger(source) || source <= 0) return { errorKey: 'venues.errorCopySourceInvalid' };
  if (source === req.session.admin.venueId) return { errorKey: 'venues.errorCopySameVenue' };

  // Право на источник — запросом к БД, а не сверкой со списком в сессии: копирование читает
  // чужое меню целиком, и это ровно тот случай, где ошибка означает утечку.
  const access = await adminVenueModel.findAccess(req.session.admin.id, source);
  if (!access) return { errorKey: 'venues.errorCopyNoAccess' };

  return { sourceVenueId: source, withPhotos, withPrices };
}

router.get('/', requireNetwork, async (req, res, next) => {
  try {
    const adminId = req.session.admin.id;
    const [rows, dailyRows] = await Promise.all([
      adminVenueModel.summaryForAdmin(adminId),
      adminVenueModel.dailyViewsForAdmin(adminId),
    ]);

    const venues = rows.map((row) => ({
      ...row,
      // Статус подписки считается тем же кодом, что и на экране подписки, — иначе одно
      // и то же заведение показывало бы «активна» в сводке и «просрочена» внутри.
      subscriptionState: computeSubscriptionStatus(row.subscription_until),
    }));

    // Предпросмотр (промт: «с предпросмотром количества категорий и позиций») — это GET
    // с параметрами в адресе, а не POST: он ничего не меняет, его можно перечитать
    // обновлением страницы, и после него не нужен PRG.
    let copyPreview = null;
    let copyParams = { sourceVenueId: null, withPhotos: true, withPrices: true };
    // Ошибка после PRG приходит КЛЮЧОМ словаря в адресе — переводится в шаблоне. Ключ
    // проверяем по префиксу, иначе произвольная строка из адресной строки попала бы в t()
    // и отрисовалась как текст.
    let copyError = typeof req.query.copy_error === 'string' && req.query.copy_error.startsWith('venues.')
      ? req.query.copy_error
      : null;

    if (req.query.source_venue_id !== undefined) {
      const parsed = await parseCopyParams(req);
      if (parsed.errorKey) {
        copyError = parsed.errorKey;
      } else {
        copyParams = parsed;
        const counts = await menuCopy.preview(parsed.sourceVenueId);
        if (counts.items === 0) copyError = 'venues.errorCopyEmpty';
        else copyPreview = counts;
      }
    }

    res.render('admin/venues', {
      venues,
      totalViews: venues.reduce((sum, venue) => sum + venue.views_week, 0),
      viewsChart: venuePageViewModel.buildDailyBuckets(dailyRows),
      summaryDays: adminVenueModel.SUMMARY_DAYS,
      copyPreview,
      copyError,
      copyParams,
      // Результат копирования приходит ключом словаря и числами в query после PRG.
      copiedCategories: Number(req.query.copied_categories) || 0,
      copiedItems: Number(req.query.copied_items) || 0,
      login: req.session.admin.login,
      role: req.session.admin.role,
      venueSlug: req.session.admin.venueSlug,
    });
  } catch (err) {
    next(err);
  }
});

// Промт: «Выполняется в транзакции». Копируется ВСЕГДА в активное заведение — цель не берётся
// из формы вовсе, чтобы её нельзя было подменить.
router.post('/copy', requireNetwork, async (req, res, next) => {
  try {
    const parsed = await parseCopyParams(req);
    if (parsed.errorKey) {
      return res.redirect(`/admin/venues?copy_error=${encodeURIComponent(parsed.errorKey)}`);
    }

    const targetVenueId = req.session.admin.venueId;
    let result;
    try {
      result = await menuCopy.copyMenu({
        sourceVenueId: parsed.sourceVenueId,
        targetVenueId,
        withPhotos: parsed.withPhotos,
        withPrices: parsed.withPrices,
        actorAdminId: req.session.admin.id,
      });
    } catch (err) {
      if (err.message === 'COPY_SOURCE_EMPTY') {
        return res.redirect('/admin/venues?copy_error=venues.errorCopyEmpty');
      }
      throw err;
    }

    // Меню заведения изменилось целиком — версия и кеш обязаны это увидеть, иначе гости
    // ещё пять минут будут получать старое меню из кеша.
    await pgNotify.publishMenuChange(targetVenueId);

    return res.redirect(`/admin/venues?copied_categories=${result.categories}&copied_items=${result.items}`);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
