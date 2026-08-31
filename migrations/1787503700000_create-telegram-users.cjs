/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('telegram_users', {
    telegram_id: { type: 'bigint', notNull: true, primaryKey: true },
    username: { type: 'text' },
    first_name: { type: 'text' },
    lang: { type: 'text', notNull: true, default: 'ru' },
    is_blocked: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('telegram_users', 'telegram_users_lang_check', "CHECK (lang IN ('ru', 'uz', 'en'))");
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('telegram_users');
};
