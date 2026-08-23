/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('admin_action_logs', {
    id: 'id',
    admin_id: {
      type: 'integer',
      notNull: true,
      references: 'admins',
      onDelete: 'RESTRICT',
    },
    venue_id: {
      type: 'integer',
      notNull: true,
      references: 'venues',
      onDelete: 'RESTRICT',
    },
    action_type: { type: 'text', notNull: true },
    entity_type: { type: 'text', notNull: true },
    entity_id: { type: 'integer', notNull: true },
    details: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('admin_action_logs', 'venue_id');
  pgm.createIndex('admin_action_logs', 'admin_id');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_action_type_check',
    "CHECK (action_type IN ('create', 'update', 'delete', 'toggle_availability'))"
  );
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('admin_action_logs');
};
