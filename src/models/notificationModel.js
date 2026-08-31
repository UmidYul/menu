const { pool } = require('../config/db');

// Ставит уведомление в очередь. clientOrPool позволяет вызывать это в той же транзакции, что и
// событие, которое его породило (см. superadmin.js /venues/:id/extend) — если транзакция
// откатится, уведомление не должно остаться висеть в базе.
async function enqueue(clientOrPool, { channel, recipient, template, payload, lang, scheduledAt, dedupKey }) {
  const executor = clientOrPool || pool;
  const result = await executor.query(
    `INSERT INTO notifications (channel, recipient, template, payload, lang, scheduled_at, dedup_key)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
     RETURNING *`,
    [channel, recipient, template, payload ? JSON.stringify(payload) : '{}', lang || 'ru', scheduledAt || null, dedupKey || null]
  );
  return result.rows[0];
}

// Захватывает пачку "готовых к отправке" записей под SELECT ... FOR UPDATE SKIP LOCKED, чтобы
// два воркера не забрали одну и ту же запись. Статуса "processing" в схеме нет — вместо этого
// claim одним атомарным UPDATE увеличивает attempts и отодвигает scheduled_at на пару минут
// вперёд ("аренда"): пока воркер её обрабатывает, она не попадёт в выборку повторно, а если
// воркер упадёт, не вызвав markSent/markFailed, запись сама вернётся в пул после истечения аренды.
const CLAIM_LEASE = "interval '2 minutes'";

async function claimBatch(limit) {
  const result = await pool.query(
    `UPDATE notifications
     SET attempts = attempts + 1,
         scheduled_at = now() + ${CLAIM_LEASE}
     WHERE id IN (
       SELECT id FROM notifications
       WHERE status = 'pending' AND scheduled_at <= now()
       ORDER BY scheduled_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit]
  );
  return result.rows;
}

async function markSent(id) {
  await pool.query(
    `UPDATE notifications SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
    [id]
  );
}

// nextScheduledAt задан — попытка неудачная, но не последняя: возвращаем в 'pending' с новым
// временем (график ретраев считает вызывающий код). Не задан — попытки исчерпаны, статус финальный.
async function markFailed(id, error, nextScheduledAt) {
  if (nextScheduledAt) {
    await pool.query(
      `UPDATE notifications SET status = 'pending', last_error = $2, scheduled_at = $3 WHERE id = $1`,
      [id, error, nextScheduledAt]
    );
  } else {
    await pool.query(
      `UPDATE notifications SET status = 'failed', last_error = $2 WHERE id = $1`,
      [id, error]
    );
  }
}

// Получатель заблокировал бота и т.п. — без ретраев, финально.
async function markSkipped(id, reason) {
  await pool.query(
    `UPDATE notifications SET status = 'skipped', last_error = $2 WHERE id = $1`,
    [id, reason || null]
  );
}

// Для /stats и /pending в боте — сколько уведомлений сейчас в очереди и сколько зависло с ошибкой.
async function countByStatus() {
  const result = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM notifications GROUP BY status`
  );
  const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of result.rows) counts[row.status] = row.count;
  return counts;
}

module.exports = { enqueue, claimBatch, markSent, markFailed, markSkipped, countByStatus };
