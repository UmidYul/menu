const { pool } = require('../config/db');

async function logAction(clientOrPool, { adminId, venueId, actionType, entityType, entityId, details }) {
  const executor = clientOrPool || pool;
  await executor.query(
    `INSERT INTO admin_action_logs (admin_id, venue_id, action_type, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, venueId, actionType, entityType, entityId, details ? JSON.stringify(details) : null]
  );
}

module.exports = { logAction };
