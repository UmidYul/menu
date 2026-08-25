/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('payments', {
    id: 'id',
    venue_id: {
      type: 'integer',
      notNull: true,
      references: 'venues',
      onDelete: 'RESTRICT',
    },
    amount: { type: 'numeric', notNull: true },
    currency: { type: 'text', notNull: true, default: 'UZS' },
    method: { type: 'text', notNull: true },
    comment: { type: 'text' },
    paid_at: { type: 'date', notNull: true },
    extends_until: { type: 'date', notNull: true },
    created_by: {
      type: 'integer',
      notNull: true,
      references: 'admins',
      onDelete: 'RESTRICT',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('payments', 'venue_id');
  pgm.addConstraint('payments', 'payments_amount_check', 'CHECK (amount > 0)');
  pgm.addConstraint(
    'payments',
    'payments_method_check',
    "CHECK (method IN ('cash', 'card', 'click', 'payme', 'other'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('payments');
};
