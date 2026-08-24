/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Часы работы убраны из продукта: ни в кабинете заведения, ни на публичном меню больше не
// редактируются и не показываются.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.dropColumn('venues', 'working_hours');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.addColumn('venues', {
    working_hours: { type: 'jsonb' },
  });
};
