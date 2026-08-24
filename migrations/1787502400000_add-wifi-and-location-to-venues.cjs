/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('venues', {
    latitude: { type: 'numeric(9,6)' },
    longitude: { type: 'numeric(9,6)' },
    wifi_ssid: { type: 'text' },
    wifi_password: { type: 'text' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('venues', ['latitude', 'longitude', 'wifi_ssid', 'wifi_password']);
};
