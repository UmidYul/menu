/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('venue_page_views', {
    id: 'id',
    venue_id: {
      type: 'integer',
      notNull: true,
      references: 'venues',
      onDelete: 'CASCADE',
    },
    viewed_on: { type: 'date', notNull: true },
    view_count: { type: 'integer', notNull: true, default: 0 },
  });

  pgm.addConstraint('venue_page_views', 'venue_page_views_venue_date_unique', 'UNIQUE (venue_id, viewed_on)');
  pgm.createIndex('venue_page_views', 'venue_id');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('venue_page_views');
};
