const express = require('express');

const router = express.Router();
const { requireAuth, requireVenueRole } = require('../middlewares/auth');
const venueModel = require('../models/venueModel');
const venueTableModel = require('../models/venueTableModel');
const print = require('../services/print');
const siteSettingsCache = require('../services/siteSettingsCache');
const { loadLogoPng } = require('../services/print/logo');
const { t, SUPPORTED_LANGS } = require('../i18n');

// venueStatusGate не ставим по той же причине, что на /admin/analytics: это не редактирование
// меню. Плюс промт 3.4 прямо разрешает печатать заведению в статусе draft — с предупреждением.
router.use(requireAuth, requireVenueRole(['owner', 'manager']));

const MAX_TABLES = 200;

// Разбор настроек из query — общий для предпросмотра и скачивания, чтобы обе кнопки
// гарантированно рисовали одно и то же.
async function readOptions(req, venue) {
  // Домен печатается внизу всех макетов и задаётся суперадмином в настройках сайта
  // (site_settings.print_domain). Берём из того же кэша, что и футер лендинга.
  const siteSettings = await siteSettingsCache.get();
  const enabled = venue.enabled_langs || ['ru', 'uz'];
  const requested = [].concat(req.query.langs || []);
  const langs = SUPPORTED_LANGS.filter((l) => enabled.includes(l) && requested.includes(l));
  // Ни один язык не выбран — берём язык заведения по умолчанию, пустой призыв в макете
  // выглядел бы как ошибка вёрстки.
  const ctaLangs = langs.length ? langs : [venue.lang_default || 'ru'];

  const showLogo = req.query.logo === '1';
  const showContacts = req.query.contacts === '1';

  const allTables = (await venueTableModel.listByVenue(venue.id)).filter((table) => table.is_active);
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  const ranged = (Number.isInteger(from) && Number.isInteger(to) && from > 0 && to >= from)
    ? allTables.slice(from - 1, to)
    : allTables;

  return {
    venue,
    baseUrl: `${req.protocol}://${req.get('host')}`,
    ctaLines: ctaLangs.map((lang) => t('print.ctaLine', lang)),
    showLogo,
    showContacts,
    logo: showLogo ? await loadLogoPng(venue.logo_url) : null,
    tables: ranged.slice(0, MAX_TABLES),
    tableLabel: (number) => t('print.tableLabel', ctaLangs[0], { number }),
    domain: siteSettings && siteSettings.print_domain,
    allTablesCount: allTables.length,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const venue = await venueModel.findById(req.session.admin.venueId);
    if (!venue) return res.status(500).render('errors/500');

    const tables = (await venueTableModel.listByVenue(venue.id)).filter((table) => table.is_active);
    const enabledLangs = SUPPORTED_LANGS.filter((l) => (venue.enabled_langs || ['ru', 'uz']).includes(l));

    return res.render('admin/print', {
      venue,
      layouts: print.LAYOUTS.map((l) => ({
        id: l.id,
        widthMm: l.widthMm,
        heightMm: l.heightMm,
        perTable: Boolean(l.perTable),
        perPage: l.perPage || null,
        bleed: Boolean(l.bleed),
      })),
      enabledLangs,
      tablesCount: tables.length,
      // Промт 3.4: печатать в draft можно, но с предупреждением — QR ведёт на страницу,
      // которая гостю ещё не открывается.
      isDraft: venue.status === 'draft',
      // Символы названия, которых нет в печатных шрифтах — предупреждаем заранее.
      unsupported: print.unsupportedCharacters(venue.name),
      login: req.session.admin.login,
      role: req.session.admin.role,
      venueSlug: venue.slug,
    });
  } catch (err) {
    return next(err);
  }
});

// Предпросмотр первой страницы — тем же кодом макета, но в SVG (см. комментарий в services/print).
router.get('/preview.svg', async (req, res, next) => {
  try {
    const venue = await venueModel.findById(req.session.admin.venueId);
    if (!venue) return res.status(404).end();

    const options = await readOptions(req, venue);
    const svg = print.renderPreviewSvg(req.query.layout, options);

    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'no-store');
    return res.send(svg);
  } catch (err) {
    if (err.code === 'QR_TOO_SMALL') return res.status(422).send('');
    return next(err);
  }
});

router.get('/download.pdf', async (req, res, next) => {
  try {
    const venue = await venueModel.findById(req.session.admin.venueId);
    if (!venue) return res.status(404).end();

    const layout = print.LAYOUTS_BY_ID.get(req.query.layout);
    if (!layout) return res.status(404).end();

    const options = await readOptions(req, venue);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${venue.slug}-${layout.id}.pdf"`);
    res.set('Cache-Control', 'no-store');
    // Пишем прямо в ответ: документ не собирается в памяти целиком (промт 3.4 — потоково).
    print.renderPdf(layout.id, options, res);
    return undefined;
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
