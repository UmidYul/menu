const express = require('express');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const { domainCheckLimiter } = require('../middlewares/rateLimit');
const venueDomainModel = require('../models/venueDomainModel');
const venueModel = require('../models/venueModel');
const domainVerification = require('../services/domainVerification');
const pgNotify = require('../services/pgNotify');
const { logAction } = require('../models/adminActionLogModel');
const { domainSchema } = require('../validators/domainValidators');
const { withWww, stripWww, unicodeOf } = require('../utils/domainName');
const { pool } = require('../config/db');
const env = require('../config/env');

// Промт 3.7, раздел 4. «Свой домен» — раздел настроек заведения, но ОТДЕЛЬНЫМ маршрутом:
// формы подключения и отключения домена не могут быть вложены в форму настроек (вложенные
// <form> запрещены в HTML — тот же приём, что у групп опций в промте 2.1 и расписаний в 2.3).
//
// Только owner и manager: домен — это публичное лицо заведения, и менять его официанту
// незачем. Подписка тут ни при чём, поэтому venueStatusGate не ставим: приостановленное
// заведение должно видеть свой домен и уметь его отключить.
router.use(requireAuth, requireVenueRole(['owner', 'manager']));

// Ключ ошибки приходит после PRG в адресе. Проверяем префикс, иначе произвольная строка
// из адресной строки попала бы в t() и отрисовалась как текст.
function readMessageKey(value) {
  return typeof value === 'string' && value.startsWith('domains.') ? value : null;
}

async function renderPage(req, res, status) {
  const venueId = req.session.admin.venueId;
  const [venue, domains] = await Promise.all([
    venueModel.findById(venueId),
    venueDomainModel.listForVenue(venueId),
  ]);

  // Что видно в DNS ПРЯМО СЕЙЧАС — промт: «Если DNS настроен неверно — показать, что именно
  // видно сейчас и что ожидается». Запрашивается при открытии страницы, а не берётся из БД:
  // владелец обычно приходит сюда сразу после правки записей, и показывать ему картину
  // пятиминутной давности значит отвечать не на тот вопрос, который он задал.
  //
  // Только для доменов, которые ещё не работают: у активного домена смотреть нечего, а лишние
  // обращения к DNS на каждом открытии страницы настроек ни к чему.
  const inspections = new Map();
  await Promise.all(domains
    .filter((d) => d.status !== 'active' && d.status !== 'disabled')
    .map(async (d) => {
      try {
        inspections.set(d.id, await domainVerification.inspectDomain(d.domain, d.verification_token));
      } catch {
        // Проверка DNS — вспомогательная информация на странице, и её отказ не должен
        // превращать страницу настроек в ошибку.
        inspections.set(d.id, null);
      }
    }));

  const rows = domains.map((d) => ({
    ...d,
    // Показываем читаемое имя, храним и сравниваем punycode.
    display: unicodeOf(d.domain),
    inspection: inspections.get(d.id) || null,
    lastErrorKey: readMessageKey(d.last_error),
  }));

  // Что предложить добавить вторым адресом. Если основной уже с www — предлагаем без него,
  // и наоборот: пара всегда «голый плюс www», в любом порядке добавления.
  const primary = rows.find((d) => d.is_primary);
  const suggestion = primary && rows.length < 2
    ? (primary.domain.startsWith('www.') ? stripWww(primary.domain) : withWww(primary.domain))
    : null;

  res.status(status || 200).render('admin/domain', {
    venue,
    domains: rows,
    suggestion,
    suggestionDisplay: suggestion ? unicodeOf(suggestion) : null,
    txtPrefix: domainVerification.TXT_PREFIX,
    cnameTarget: (env.CUSTOM_DOMAIN_CNAME_TARGET || '').split(':')[0] || null,
    serverIp: env.SERVER_IPV4,
    domainsConfigured: env.customDomainsConfigured,
    error: readMessageKey(req.query.error),
    notice: readMessageKey(req.query.notice),
    formValue: typeof req.query.value === 'string' ? req.query.value.slice(0, 400) : '',
    login: req.session.admin.login,
    role: req.session.admin.role,
    venueSlug: req.session.admin.venueSlug,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await renderPage(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = domainSchema.safeParse(req.body);
    if (!parsed.success) {
      const key = parsed.error.issues[0].message;
      const raw = typeof req.body.domain === 'string' ? req.body.domain.slice(0, 400) : '';
      return res.redirect(`/admin/domain?error=${encodeURIComponent(key)}&value=${encodeURIComponent(raw)}`);
    }

    const venueId = req.session.admin.venueId;
    const domain = parsed.data.domain;

    const result = await venueDomainModel.add({ venueId, domain, isPrimary: true });
    if (result.error) {
      // Основной уже есть — пробуем добавить этот же домен алиасом. Так владелец, у которого
      // уже подключён голый домен, добавляет www вторым, не разбираясь в том, что такое
      // «основной» и «алиас»: интерфейс просто принимает второй адрес.
      if (result.error === 'too_many') {
        const asAlias = await venueDomainModel.add({ venueId, domain, isPrimary: false });
        if (asAlias.error) {
          return res.redirect(`/admin/domain?error=domains.${asAlias.error === 'taken' ? 'errorTaken' : 'errorTooMany'}`);
        }
        await logAction(pool, {
          adminId: req.session.admin.id,
          venueId,
          actionType: 'create',
          entityType: 'domain',
          entityId: asAlias.domain.id,
          details: { domain, is_primary: false },
        });
        return res.redirect('/admin/domain');
      }
      return res.redirect('/admin/domain?error=domains.errorTaken');
    }

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId,
      actionType: 'create',
      entityType: 'domain',
      entityId: result.domain.id,
      details: { domain, is_primary: true },
    });

    // Галочка «заодно подключить www». Неудача здесь не отменяет основной домен: второй адрес
    // — удобство, а не условие работы, и падать из-за него на уже сделанном шаге неправильно.
    const alsoWww = req.body.with_www === '1' || req.body.with_www === 'on';
    if (alsoWww) {
      const alias = domain.startsWith('www.') ? stripWww(domain) : withWww(domain);
      const aliasResult = await venueDomainModel.add({ venueId, domain: alias, isPrimary: false });
      if (aliasResult.domain) {
        await logAction(pool, {
          adminId: req.session.admin.id,
          venueId,
          actionType: 'create',
          entityType: 'domain',
          entityId: aliasResult.domain.id,
          details: { domain: alias, is_primary: false },
        });
      }
    }

    return res.redirect('/admin/domain');
  } catch (err) {
    return next(err);
  }
});

// «Проверить сейчас». Сама проверка НЕ делается здесь: маршрут только двигает срок,
// а проверяет планировщик (bot/worker/domainScheduler.js). Так у кнопки и у автоматической
// проверки одна и та же реализация, и кнопка физически не может проверить домен как-то иначе,
// чем это будет происходить дальше само.
router.post('/:id/check', domainCheckLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.redirect('/admin/domain?error=domains.errorNotFound');

    const updated = await venueDomainModel.requestImmediateCheck(id, req.session.admin.venueId);
    if (!updated) return res.redirect('/admin/domain?error=domains.errorNotFound');

    return res.redirect('/admin/domain?notice=domains.checkNowQueued');
  } catch (err) {
    return next(err);
  }
});

// «Начать проверку заново» после 'failed' — возврат в очередь с обнулённым счётчиком попыток
// и, значит, новыми 48 часами.
router.post('/:id/retry', domainCheckLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.redirect('/admin/domain?error=domains.errorNotFound');

    const updated = await venueDomainModel.retry(id, req.session.admin.venueId);
    if (!updated) return res.redirect('/admin/domain?error=domains.errorNotFound');

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'update',
      entityType: 'domain',
      entityId: id,
      details: { domain: updated.domain, retry: true },
    });

    return res.redirect('/admin/domain?notice=domains.checkNowQueued');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/disable', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.redirect('/admin/domain?error=domains.errorNotFound');

    const removed = await venueDomainModel.remove(id, req.session.admin.venueId);
    if (!removed) return res.redirect('/admin/domain?error=domains.errorNotFound');

    await logAction(pool, {
      adminId: req.session.admin.id,
      venueId: req.session.admin.venueId,
      actionType: 'delete',
      entityType: 'domain',
      entityId: id,
      details: { domain: removed.domain, was_status: removed.status },
    });

    // Маршрутизация по хосту обязана узнать об этом немедленно: иначе веб-процесс продолжит
    // отдавать меню по только что отключённому домену до следующей перезагрузки кэша.
    await pgNotify.publishDomainChange();

    return res.redirect('/admin/domain?notice=domains.disabled');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
