/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('payment_claims', {
    id: 'id',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    months: { type: 'integer', notNull: true },
    amount: { type: 'numeric(12,2)', notNull: true },
    currency: { type: 'text', notNull: true, default: 'UZS' },
    method: { type: 'text', notNull: true, default: 'card_transfer' },
    payer_note: { type: 'text' },
    receipt_url: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'pending' },
    reviewed_by: { type: 'integer', references: 'admins' },
    reviewed_at: { type: 'timestamptz' },
    reject_reason: { type: 'text' },
    payment_id: { type: 'integer', references: 'payments' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('payment_claims', 'payment_claims_months_check', 'CHECK (months IN (1, 3, 6, 12))');
  pgm.addConstraint(
    'payment_claims',
    'payment_claims_status_check',
    "CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))"
  );

  // Пока заявка не обработана — вторую от того же заведения не создать. Ограничение снимается
  // как только текущая уходит из pending (approved/rejected/cancelled), тот же приём, что и
  // dedup_key в notifications (частичный уникальный индекс, не полный).
  pgm.createIndex('payment_claims', 'venue_id', { unique: true, where: "status = 'pending'" });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('payment_claims');
};
