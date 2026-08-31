const { pool } = require('../config/db');

async function create(clientOrPool, { venueId, months, amount, currency, payerNote, receiptUrl }) {
  const executor = clientOrPool || pool;
  const result = await executor.query(
    `INSERT INTO payment_claims (venue_id, months, amount, currency, payer_note, receipt_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [venueId, months, amount, currency || 'UZS', payerNote || null, receiptUrl || null]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM payment_claims WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function findPendingByVenue(venueId) {
  const result = await pool.query(
    `SELECT * FROM payment_claims WHERE venue_id = $1 AND status = 'pending' LIMIT 1`,
    [venueId]
  );
  return result.rows[0] || null;
}

async function listByVenue(venueId) {
  const result = await pool.query(
    'SELECT * FROM payment_claims WHERE venue_id = $1 ORDER BY created_at DESC',
    [venueId]
  );
  return result.rows;
}

// list({status, page}) — тот же пагинационный паттерн, что leadModel.list.
const PAGE_SIZE = 25;
async function list({ status, page }) {
  const conditions = [];
  const values = [];
  if (status) {
    values.push(status);
    conditions.push(`pc.status = $${values.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safePage = Math.max(1, page || 1);
  const offset = (safePage - 1) * PAGE_SIZE;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT pc.*, v.name AS venue_name, v.slug AS venue_slug
       FROM payment_claims pc
       JOIN venues v ON v.id = pc.venue_id
       ${where}
       ORDER BY pc.created_at DESC LIMIT ${PAGE_SIZE} OFFSET $${values.length + 1}`,
      [...values, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS count FROM payment_claims pc ${where}`, values),
  ]);

  return {
    rows: rowsResult.rows,
    total: countResult.rows[0].count,
    page: safePage,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(countResult.rows[0].count / PAGE_SIZE)),
  };
}

async function countPending() {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM payment_claims WHERE status = 'pending'`);
  return result.rows[0].count;
}

// approve/reject/cancel всегда переводят из pending и всегда внутри транзакции вызывающего кода
// (см. src/services/payment/providers/manual.js) — статус проверяется там же, чтобы гонка
// "заведение отменило, пока владелец подтверждал" решалась атомарно, а не в два отдельных запроса.
async function markApproved(client, id, { reviewedBy, paymentId }) {
  const result = await client.query(
    `UPDATE payment_claims SET status = 'approved', reviewed_by = $1, reviewed_at = now(), payment_id = $2
     WHERE id = $3 AND status = 'pending' RETURNING *`,
    [reviewedBy || null, paymentId, id]
  );
  return result.rows[0] || null;
}

async function markRejected(client, id, { reviewedBy, reason }) {
  const executor = client || pool;
  const result = await executor.query(
    `UPDATE payment_claims SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), reject_reason = $2
     WHERE id = $3 AND status = 'pending' RETURNING *`,
    [reviewedBy || null, reason, id]
  );
  return result.rows[0] || null;
}

async function markCancelled(id, venueId) {
  const result = await pool.query(
    `UPDATE payment_claims SET status = 'cancelled', reviewed_at = now()
     WHERE id = $1 AND venue_id = $2 AND status = 'pending' RETURNING *`,
    [id, venueId]
  );
  return result.rows[0] || null;
}

module.exports = {
  create,
  findById,
  findPendingByVenue,
  listByVenue,
  list,
  countPending,
  markApproved,
  markRejected,
  markCancelled,
};
