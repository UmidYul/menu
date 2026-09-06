/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('venue_telegram_links', {
    id: 'id',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    admin_id: { type: 'integer', notNull: true, references: 'admins', onDelete: 'CASCADE' },
    code: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('venue_telegram_links', 'admin_id');
  // Код регистронезависимый — хранится в верхнем регистре, сравнение тоже по верхнему регистру.
  pgm.createIndex('venue_telegram_links', 'code', { unique: true });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('venue_telegram_links');
};
