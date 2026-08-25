const { pool } = require('../config/db');

async function create(client, { venueId, amount, currency, method, comment, paidAt, extendsUntil, createdBy }) {
  const result = await client.query(
    `INSERT INTO payments (venue_id, amount, currency, method, comment, paid_at, extends_until, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [venueId, amount, currency, method, comment, paidAt, extendsUntil, createdBy]
  );
  return result.rows[0];
}

async function listByVenue(venueId) {
  const result = await pool.query(
    `SELECT p.id, p.amount, p.currency, p.method, p.comment, p.paid_at, p.extends_until, p.created_at,
            a.login AS created_by_login
     FROM payments p
     JOIN admins a ON a.id = p.created_by
     WHERE p.venue_id = $1
     ORDER BY p.paid_at DESC, p.created_at DESC`,
    [venueId]
  );
  return result.rows;
}

module.exports = { create, listByVenue };
