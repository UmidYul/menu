const express = require('express');

const router = express.Router();
const venueModel = require('../models/venueModel');
const menuCache = require('../services/menuCache');
const { renderVenueOgImage } = require('../services/ogImage');
const { SERVICE_NAME } = require('../config/constants');
const { SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');
const { escapeHtml: escapeXml } = require('../utils/escapeHtml');

function baseUrlOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

router.get('/robots.txt', (req, res) => {
  const base = baseUrlOf(req);
  // Промт 3.7: на кастомном домене админки и суперадминки нет вовсе — они отсеяны редиректом
  // (см. middlewares/customDomain.js), и запрещать роботам несуществующие пути незачем.
  const disallow = req.customDomain ? [] : ['Disallow: /admin', 'Disallow: /superadmin'];
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      ...disallow,
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

// xhtml:link alternates внутри <url> — те же языковые версии, что заведение объявляет через
// hreflang на самой странице меню (buildSeoInfo в publicMenu.js): по одному <url> на venue
// (канонический голый адрес), а не отдельная запись на каждый язык.
function buildAlternateLinks(loc, enabledLangs) {
  const langs = SUPPORTED_LANGS.filter((l) => enabledLangs.includes(l));
  const altTags = langs
    .map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${escapeXml(`${loc}?lang=${l}`)}"/>`)
    .join('\n');
  return `${altTags}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(loc)}"/>`;
}

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const base = baseUrlOf(req);

    // Промт 3.7: «sitemap на кастомном домене указывает на него же». Здесь это не только смена
    // адреса, но и смена СОСТАВА: на своём домене у заведения нет ни лендинга, ни чужих меню —
    // есть ровно одна страница, его собственная, и живёт она в корне. Отдать тут общий sitemap
    // сервиса значило бы предложить поисковику обойти сотню адресов, которых на этом домене нет.
    if (req.customDomain) {
      const own = await venueModel.findPublicBySlug(req.customDomain.slug);
      if (!own || !own.is_active) return res.status(404).end();
      const loc = `${base}/`;
      const alternates = buildAlternateLinks(loc, own.enabled_langs || ['ru', 'uz']);
      const ownXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n${alternates}\n  </url>\n</urlset>\n`;
      return res.type('application/xml').send(ownXml);
    }

    const venues = await venueModel.listActiveSlugs();

    const homeUrl = `  <url>\n    <loc>${escapeXml(`${base}/`)}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`;

    const venueUrls = venues.map((venue) => {
      const loc = `${base}/menu/${venue.slug}`;
      const lastmodTag = venue.created_at ? `\n    <lastmod>${new Date(venue.created_at).toISOString()}</lastmod>` : '';
      const alternates = buildAlternateLinks(loc, venue.enabled_langs || ['ru', 'uz']);
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmodTag}\n    <changefreq>daily</changefreq>\n    <priority>0.9</priority>\n${alternates}\n  </url>`;
    });

    const body = [homeUrl, ...venueUrls].join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${body}\n</urlset>\n`;

    return res.type('application/xml').send(xml);
  } catch (err) {
    return next(err);
  }
});

router.get('/og/:slug/image.png', async (req, res, next) => {
  try {
    const { slug } = req.params;
    // URL всегда приходит с ?lang= уже выставленным той страницей, что на неё ссылается
    // (см. buildSeoInfo в publicMenu.js) — здесь просто подстраховка на случай прямого захода,
    // без похода в БД за enabled_langs заведения (эта картинка не показывает контент меню,
    // только имя заведения и подпись сервиса, так что не критично к проверке enabled_langs).
    const lang = SUPPORTED_LANGS.includes(req.query.lang) ? req.query.lang : DEFAULT_LANG;

    const cached = menuCache.getOgImage(slug, lang);
    if (cached) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(cached);
    }

    const venue = await venueModel.findPublicBySlug(slug);
    if (!venue || !venue.is_active) return res.status(404).end();

    const png = await renderVenueOgImage(venue.name, SERVICE_NAME, lang);
    menuCache.setOgImage(venue.id, slug, lang, png);

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
