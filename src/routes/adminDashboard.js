const express = require('express');

const router = express.Router();
const { requireAuth } = require('../middlewares/auth');
const { pool } = require('../config/db');

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

    res.render('admin/dashboard', { login, role, venue });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
