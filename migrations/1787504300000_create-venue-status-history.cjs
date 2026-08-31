/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('venue_status_history', {
    id: 'id',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    from_status: { type: 'text', notNull: true },
    to_status: { type: 'text', notNull: true },
    reason: { type: 'text' },
    // NULL — переход выполнила почасовая задача (bot/worker/scheduler.js), не человек. Та же
    // логика, что и у admin_action_logs.admin_id для действий бота (см. 1787504100000).
    actor_admin_id: { type: 'integer', references: 'admins' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('venue_status_history', ['venue_id', 'created_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('venue_status_history');
};
