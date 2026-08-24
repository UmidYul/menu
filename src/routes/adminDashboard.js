const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();
const { requireAuth, requireRole } = require('../middlewares/auth');
const { pool } = require('../config/db');
const itemModel = require('../models/itemModel');
const venuePageViewModel = require('../models/venuePageViewModel');

const RECENT_ITEMS_LIMIT = 5;

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { role, venueId, login } = req.session.admin;

    if (role === 'superadmin') {
      return res.redirect('/superadmin/venues');
    }

    const venueResult = await pool.query('SELECT id, name, slug, is_active FROM venues WHERE id = $1', [venueId]);
    const venue = venueResult.rows[0];

    if (!venue) {
      return res.status(500).render('errors/500');
    }

    const [stats, recentItems] = await Promise.all([
      venuePageViewModel.getStats(venueId),
      itemModel.listRecentByVenue(venueId, RECENT_ITEMS_LIMIT),
    ]);

    res.render('admin/dashboard', { login, role, venue, stats, recentItems });
  } catch (err) {
    next(err);
  }
});

// Настоящий сканируемый QR-код на публичное меню заведения (генерируется на лету, не хранится).
router.get('/qr.png', requireRole(['venue_admin']), async (req, res, next) => {
  try {
    const venueResult = await pool.query('SELECT slug FROM venues WHERE id = $1', [req.session.admin.venueId]);
    const venue = venueResult.rows[0];
    if (!venue) {
      return res.status(404).end();
    }

    const menuUrl = `${req.protocol}://${req.get('host')}/menu/${venue.slug}`;
    const buffer = await QRCode.toBuffer(menuUrl, {
      type: 'png',
      width: 480,
      margin: 1,
      color: { dark: '#27251f', light: '#fffdf8' },
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
