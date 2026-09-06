/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('admins', {
    must_change_password: { type: 'boolean', notNull: true, default: false },
    email: { type: 'text', unique: true },
    telegram_id: { type: 'bigint', unique: true },
    failed_login_count: { type: 'integer', notNull: true, default: 0 },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('admins', ['must_change_password', 'email', 'telegram_id', 'failed_login_count']);
};
