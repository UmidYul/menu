const express = require('express');

const router = express.Router();
const { pool } = require('../config/db');
const venueModel = require('../models/venueModel');
const venueTableModel = require('../models/venueTableModel');
const reviewModel = require('../models/reviewModel');
const venueLifecycle = require('../services/venueLifecycle');
const { sessionHashFromRequest } = require('../services/eventTracking');
const { t, SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const { reviewSubmitSchema, externalClickSchema } = require('../validators/reviewValidators');

const TABLE_COOKIE_PREFIX = 'mt_';

function guestLang(req, venue) {
  const cookieLang = req.cookies && req.cookies.menu_lang;
  if (SUPPORTED_LANGS.includes(cookieLang)) return cookieLang;
  return venue.lang_default || DEFAULT_LANG;
}

// Сбор отзывов доступен, только если он включён И заведение реально показывает меню гостю.
// Промт: «не показывать приглашение к отзыву на странице заведения в статусе suspended».
// archived и is_active=false туда же — у них страница меню и так заглушка.
function reviewsAvailable(venue) {
  return Boolean(
    venue.reviews_enabled
    && venue.is_active
    && venue.status !== 'suspended'
    && venue.status !== 'archived'
  );
}

async function loadTable(req, venue) {
  const cookieValue = req.cookies && req.cookies[`${TABLE_COOKIE_PREFIX}${venue.slug}`];
  const tableId = Number(cookieValue);
  if (!Number.isInteger(tableId) || tableId <= 0) return null;
  return venueTableModel.findActiveByIdForVenue(tableId, venue.id);
}

// Показывать ли гостю приглашение — решается ЗДЕСЬ, а не в HTML меню: страница кэшируется по
// slug+lang, и «этому гостю уже показывали» в неё зашить нельзя (тот же приём, что и с номером
// стола в промте 2.4). localStorage у гостя — вторая линия, а не единственная: он чистится
// в один клик и не переживает смену браузера, поэтому сервер проверяет сам.
router.get('/:slug/context', async (req, res, next) => {
  try {
    const venue = await venueModel.findPublicBySlug(req.params.slug);
    if (!venue) return res.status(404).json({ error: 'not_found' });

    const available = reviewsAvailable(venue);
    res.set('Cache-Control', 'no-store');
    // Сбор выключен — отвечаем только этим. Ни задержку, ни порог, ни ссылки на карты гостю
    // в этом случае знать незачем: клиент всё равно ничего не покажет.
    if (!available) return res.json({ available: false });

    const existing = await reviewModel.findRecentBySessionHash(venue.id, sessionHashFromRequest(req));
    return res.json({
      available,
      // Уже оставлял отзыв за последние 30 дней — больше не зовём (промт).
      alreadyReviewed: Boolean(existing),
      delaySec: venue.reviews_prompt_delay_sec,
      threshold: venue.reviews_threshold,
      // Кнопки карт показываются только те, для которых заполнены ссылки (edge case промта:
      // «ссылки не заполнены — без пустых кнопок»).
      googleUrl: venue.google_review_url || null,
      yandexUrl: venue.yandex_review_url || null,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:slug', async (req, res, next) => {
  try {
    const venue = await venueModel.findPublicBySlug(req.params.slug);
    if (!venue) return res.status(404).json({ error: 'not_found' });

    const lang = guestLang(req, venue);
    const tt = (key, params) => t(key, lang, params);

    if (!reviewsAvailable(venue)) {
      return res.status(409).json({ error: 'reviews_disabled', message: tt('reviews.errorDisabled') });
    }

    const parsed = reviewSubmitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'bad_request' });

    const sessionHash = sessionHashFromRequest(req);
    const existing = await reviewModel.findRecentBySessionHash(venue.id, sessionHash);
    if (existing) {
      return res.status(409).json({ error: 'already_reviewed', message: tt('reviews.errorAlreadyReviewed') });
    }

    // Подозрительным помечается отзыв без текста и отзыв с тем же текстом, что и предыдущий.
    // Именно ПОМЕЧАЕТСЯ: решение принимает владелец, автоматика ничего не удаляет и не прячет.
    const comment = parsed.data.comment;
    const isSuspicious = !comment || (await reviewModel.lastCommentMatches(venue.id, comment));

    const table = await loadTable(req, venue);
    const review = await reviewModel.create({
      venueId: venue.id,
      rating: parsed.data.rating,
      comment,
      contact: parsed.data.contact,
      tableId: table ? table.id : null,
      lang,
      sessionHash,
      isSuspicious,
      externalTarget: parsed.data.external || null,
    });

    // Промт: оценка ниже порога — владельцу немедленно; высокая — не спамим, она попадёт
    // в еженедельную сводку. Идём обычной цепочкой notifyVenue: личный Telegram владельца ->
    // email заведения -> владельцу сервиса как «нужен ручной контакт».
    if (review.rating < venue.reviews_threshold) {
      await venueLifecycle.notifyVenue(pool, venue, {
        template: 'review_low_rating',
        payload: {
          venue_name: venue.name,
          venue_id: venue.id,
          rating: review.rating,
          comment: review.comment,
          contact: review.contact,
          table_number: table ? table.number : null,
        },
        dedupKey: `review_low:${review.id}`,
      });
    }

    return res.status(201).json({
      ok: true,
      reviewId: review.id,
      // Гостю возвращаем ссылки, чтобы экран благодарности не ходил за ними ещё раз.
      googleUrl: venue.google_review_url || null,
      yandexUrl: venue.yandex_review_url || null,
      hasContact: Boolean(review.contact),
    });
  } catch (err) {
    return next(err);
  }
});

// Гость нажал кнопку перехода на карты. Мы фиксируем именно НАЖАТИЕ — дошёл ли он и написал ли
// что-то на Google/Яндексе, узнать невозможно, и в админке это подписано честно.
router.post('/:slug/external', async (req, res, next) => {
  try {
    const venue = await venueModel.findPublicBySlug(req.params.slug);
    if (!venue) return res.status(404).json({ error: 'not_found' });

    const parsed = externalClickSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'bad_request' });

    // Отзыв должен принадлежать этому заведению — иначе чужой id позволил бы проставлять
    // отметки в чужих отзывах.
    const review = await reviewModel.findByIdForVenue(parsed.data.reviewId, venue.id);
    if (!review) return res.status(404).json({ error: 'not_found' });

    await reviewModel.markWentExternal(review.id, parsed.data.target);
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
