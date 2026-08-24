const { pool } = require('../config/db');

async function logAction(clientOrPool, { adminId, venueId, actionType, entityType, entityId, details }) {
  const executor = clientOrPool || pool;
  await executor.query(
    `INSERT INTO admin_action_logs (admin_id, venue_id, action_type, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, venueId, actionType, entityType, entityId, details ? JSON.stringify(details) : null]
  );
}

const PAGE_SIZE = 50;

// Список логов по всем заведениям для суперадмина, с опциональными фильтрами
// по venue_id и action_type, постранично (новые сверху).
async function listRecent({ venueId, actionType, page }) {
  const conditions = [];
  const values = [];

  if (venueId) {
    values.push(venueId);
    conditions.push(`l.venue_id = $${values.length}`);
  }
  if (actionType) {
    values.push(actionType);
    conditions.push(`l.action_type = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = Math.max(0, (page - 1) * PAGE_SIZE);

  const [rowsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT l.id, l.action_type, l.entity_type, l.entity_id, l.details, l.created_at,
              a.login AS admin_login, v.name AS venue_name, v.slug AS venue_slug
       FROM admin_action_logs l
       JOIN admins a ON a.id = l.admin_id
       JOIN venues v ON v.id = l.venue_id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT ${PAGE_SIZE} OFFSET $${values.length + 1}`,
      [...values, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS count FROM admin_action_logs l ${where}`, values),
  ]);

  return {
    rows: rowsResult.rows,
    total: countResult.rows[0].count,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(countResult.rows[0].count / PAGE_SIZE)),
  };
}

module.exports = { logAction, listRecent };
