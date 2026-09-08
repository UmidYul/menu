const express = require('express');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const reviewModel = require('../models/reviewModel');
const menuCache = require('../services/menuCache');
const { logAction } = require('../models/adminActionLogModel');
const { reviewsSettingsSchema } = require('../validators/reviewValidators');

// venueStatusGate здесь намеренно нет — по той же причине, что на /admin/analytics и
// /admin/orders-settings: это не редактирование меню. Приостановленное заведение должно
// иметь возможность прочитать уже накопленные отзывы и выключить сбор.
router.use(requireAuth, requireVenueRole(['owner', 'manager']));

const STATUSES = ['new', 'read', 'resolved', 'spam'];

// Фильтры из query. Всё, что не совпало с белым списком, превращается в «без фильтра» —
// значения уходят в SQL параметрами (см. reviewModel.listByVenue), но и до запроса
// произвольная строка из адресной строки в фильтр попасть не должна.
function parseFilters(query) {
  const status = STATUSES.includes(query.status) ? query.status : null;
  const ratingRaw = Number(query.rating);
  const rating = Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;
  return { status, rating };
}

// Возврат после действия — на тот же отфильтрованный список. Строку берём из УЖЕ разобранных
// фильтров, а не из req.query/Referer: так в Location физически не может попасть ни чужой
// домен, ни произвольный параметр из адресной строки.
function listUrl(filters) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.rating) params.set('rating', String(filters.rating));
  const query = params.toString();
  return query ? `/admin/reviews?${query}` : '/admin/reviews';
}

async function renderPage(req, res, { status, error, settingsValues } = {}) {
  const venueId = req.session.admin.venueId;
  const filters = parseFilters(req.query);

  const [venue, reviews, stats] = await Promise.all([
    venueModel.findById(venueId),
    reviewModel.listByVenue(venueId, filters),
    reviewModel.ratingStats(venueId),
  ]);

  res.status(status || 200).render('admin/reviews', {
    venue,
    reviews,
    stats,
    filters,
    statuses: STATUSES,
    minReviewsForRating: reviewModel.MIN_REVIEWS_FOR_RATING,
    // Значения формы настроек: после ошибки валидации — то, что ввёл владелец, иначе из БД.
    settings: settingsValues || {
      google_review_url: venue.google_review_url || '',
      yandex_review_url: venue.yandex_review_url || '',
      reviews_prompt_delay_sec: String(venue.reviews_prompt_delay_sec),
      reviews_threshold: String(venue.reviews_threshold),
    },
    error: error || null,
    login: req.session.admin.login,
    role: req.session.admin.role,
    venueSlug: venue.slug,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await renderPage(req, res);
  } catch (err) {
    next(err);
  }
});

// Сброс кэша страницы меню нужен ровно там, где меняется то, что в неё отрисовано: флаг
// reviews_enabled управляет и приглашением, и правилом расчёта рейтинга в карточке.
router.post('/toggle', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const updated = await venueModel.toggleReviewsEnabled(venueId);
    menuCache.invalidate(venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'venue',
      entityId: venueId, details: { field: 'reviews_enabled', value: updated.reviews_enabled },
    });
    res.redirect('/admin/reviews');
  } catch (err) {
    next(err);
  }
});

router.post('/settings', async (req, res, next) => {
  try {
    const { t } = res.locals;
    const parsed = reviewsSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderPage(req, res, {
        status: 422,
        error: t(parsed.error.issues[0].message),
        settingsValues: {
          google_review_url: typeof req.body.google_review_url === 'string' ? req.body.google_review_url : '',
          yandex_review_url: typeof req.body.yandex_review_url === 'string' ? req.body.yandex_review_url : '',
          reviews_prompt_delay_sec: typeof req.body.reviews_prompt_delay_sec === 'string' ? req.body.reviews_prompt_delay_sec : '',
          reviews_threshold: typeof req.body.reviews_threshold === 'string' ? req.body.reviews_threshold : '',
        },
      });
    }

    const venueId = req.session.admin.venueId;
    const updated = await venueModel.updateReviewsSettings(venueId, parsed.data);
    menuCache.invalidate(venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'venue',
      entityId: venueId,
      details: {
        google_review_url: updated.google_review_url,
        yandex_review_url: updated.yandex_review_url,
        reviews_prompt_delay_sec: updated.reviews_prompt_delay_sec,
        reviews_threshold: updated.reviews_threshold,
      },
    });
    return res.redirect('/admin/reviews');
  } catch (err) {
    return next(err);
  }
});

// Смена статуса и заметка идут по одному шаблону: venue_id входит в WHERE самого UPDATE
// (см. reviewModel), поэтому чужой отзыв не изменится, даже если id подставили руками.
router.post('/:id/status', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const id = Number(req.params.id);
    const status = STATUSES.includes(req.body.status) ? req.body.status : null;
    const backUrl = listUrl(parseFilters(req.query));
    if (!Number.isInteger(id) || !status) return res.redirect(backUrl);

    const updated = await reviewModel.updateStatus(id, venueId, status);
    if (!updated) return res.redirect(backUrl);

    // Спам исключается из среднего (см. reviewModel.ratingStats) — значит, изменился рейтинг
    // в карточке заведения, и закэшированную страницу меню надо пересобрать.
    if (status === 'spam') menuCache.invalidate(venueId);
    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'review',
      entityId: id, details: { status },
    });
    return res.redirect(backUrl);
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/note', async (req, res, next) => {
  try {
    const venueId = req.session.admin.venueId;
    const id = Number(req.params.id);
    const backUrl = listUrl(parseFilters(req.query));
    if (!Number.isInteger(id)) return res.redirect(backUrl);

    const note = typeof req.body.owner_reply === 'string' ? req.body.owner_reply.trim().slice(0, 2000) : '';
    const updated = await reviewModel.saveOwnerNote(id, venueId, note || null);
    if (!updated) return res.redirect(backUrl);

    await logAction(pool, {
      adminId: req.session.admin.id, venueId, actionType: 'update', entityType: 'review',
      entityId: id, details: { field: 'owner_reply', filled: Boolean(note) },
    });
    return res.redirect(backUrl);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
