const express = require('express');

const router = express.Router();
const venueModel = require('../models/venueModel');
const menuCache = require('../services/menuCache');
const { renderVenueOgImage } = require('../services/ogImage');
const { SERVICE_NAME } = require('../config/constants');

function baseUrlOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));
}

router.get('/robots.txt', (req, res) => {
  const base = baseUrlOf(req);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /superadmin',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const base = baseUrlOf(req);
    const venues = await venueModel.listActiveSlugs();

    const urls = [
      { loc: `${base}/`, changefreq: 'weekly', priority: '0.8' },
      ...venues.map((venue) => ({
        loc: `${base}/menu/${venue.slug}`,
        lastmod: venue.created_at ? new Date(venue.created_at).toISOString() : null,
        changefreq: 'daily',
        priority: '0.9',
      })),
    ];

    const body = urls
      .map((u) => {
        const lastmodTag = u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : '';
        return `  <url>\n    <loc>${escapeXml(u.loc)}</loc>${lastmodTag}\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`;
      })
      .join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;

    res.type('application/xml').send(xml);
  } catch (err) {
    next(err);
  }
});

router.get('/og/:slug/image.png', async (req, res, next) => {
  try {
    const { slug } = req.params;

    const cached = menuCache.getOgImage(slug);
    if (cached) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(cached);
    }

    const venue = await venueModel.findPublicBySlug(slug);
    if (!venue || !venue.is_active) return res.status(404).end();

    const png = await renderVenueOgImage(venue.name, SERVICE_NAME);
    menuCache.setOgImage(slug, png);

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
