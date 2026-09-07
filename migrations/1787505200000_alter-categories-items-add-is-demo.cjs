/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumn('categories', { is_demo: { type: 'boolean', notNull: true, default: false } });
  pgm.addColumn('items', { is_demo: { type: 'boolean', notNull: true, default: false } });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumn('categories', 'is_demo');
  pgm.dropColumn('items', 'is_demo');
};
