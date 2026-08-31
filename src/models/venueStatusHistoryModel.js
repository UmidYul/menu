const { pool } = require('../config/db');

// actorAdminId: null — переход выполнила почасовая задача (bot/worker/scheduler.js), не человек.
async function record(clientOrPool, { venueId, fromStatus, toStatus, reason, actorAdminId }) {
  const executor = clientOrPool || pool;
  const result = await executor.query(
    `INSERT INTO venue_status_history (venue_id, from_status, to_status, reason, actor_admin_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [venueId, fromStatus, toStatus, reason || null, actorAdminId || null]
  );
  return result.rows[0];
}

async function listByVenue(venueId) {
  const result = await pool.query(
    `SELECT h.*, a.login AS actor_login
     FROM venue_status_history h
     LEFT JOIN admins a ON a.id = h.actor_admin_id
     WHERE h.venue_id = $1
     ORDER BY h.created_at DESC`,
    [venueId]
  );
  return result.rows;
}

module.exports = { record, listByVenue };
