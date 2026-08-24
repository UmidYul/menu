const { pool } = require('../config/db');

async function findByLogin(login) {
  const result = await pool.query(
    `SELECT a.id, a.login, a.password_hash, a.role, a.venue_id, a.is_active,
            v.is_active AS venue_is_active, v.name AS venue_name, v.slug AS venue_slug
     FROM admins a
     LEFT JOIN venues v ON v.id = a.venue_id
     WHERE a.login = $1`,
    [login]
  );
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await pool.query(
    `SELECT a.id, a.login, a.role, a.venue_id, a.is_active,
            v.is_active AS venue_is_active, v.name AS venue_name
     FROM admins a
     LEFT JOIN venues v ON v.id = a.venue_id
     WHERE a.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function create(client, { venueId, login, passwordHash, role }) {
  const result = await client.query(
    `INSERT INTO admins (venue_id, login, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, login, role, venue_id`,
    [venueId, login, passwordHash, role]
  );
  return result.rows[0];
}

module.exports = { findByLogin, findById, create };
