/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Встроенная карта и поля координат убраны из продукта: ссылка на 2GIS остаётся
// единственным способом показать местоположение на публичном меню.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.dropColumn('venues', ['latitude', 'longitude']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.addColumns('venues', {
    latitude: { type: 'numeric(9,6)' },
    longitude: { type: 'numeric(9,6)' },
  });
};
