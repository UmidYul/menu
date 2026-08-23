/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('categories', {
    id: 'id',
    venue_id: {
      type: 'integer',
      notNull: true,
      references: 'venues',
      onDelete: 'RESTRICT',
    },
    name_ru: { type: 'text', notNull: true },
    name_uz: { type: 'text', notNull: true },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });

  pgm.createIndex('categories', 'venue_id');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('categories');
};
