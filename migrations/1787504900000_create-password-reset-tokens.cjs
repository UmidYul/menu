/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('password_reset_tokens', {
    id: 'id',
    admin_id: { type: 'integer', notNull: true, references: 'admins', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    requested_ip_hash: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('password_reset_tokens', 'admin_id');
  // Токен приходит в письме как сырое значение — ищем по хэшу, поэтому уникальный индекс
  // на token_hash (коллизия SHA-256 практически невозможна, но пусть будет гарантией на уровне БД).
  pgm.createIndex('password_reset_tokens', 'token_hash', { unique: true });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('password_reset_tokens');
};
