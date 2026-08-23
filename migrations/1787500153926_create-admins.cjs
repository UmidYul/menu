/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('admins', {
    id: 'id',
    venue_id: {
      type: 'integer',
      references: 'venues',
      onDelete: 'RESTRICT',
    },
    login: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('admins', 'admins_role_check', "CHECK (role IN ('superadmin', 'venue_admin', 'staff'))");
  pgm.addConstraint(
    'admins',
    'admins_role_venue_id_check',
    "CHECK ((role = 'superadmin' AND venue_id IS NULL) OR (role IN ('venue_admin', 'staff') AND venue_id IS NOT NULL))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('admins');
};
