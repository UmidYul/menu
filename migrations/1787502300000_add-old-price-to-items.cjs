/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumn('items', {
    old_price: { type: 'numeric(12,2)' },
  });
  pgm.addConstraint('items', 'items_old_price_gt_price_check', 'CHECK (old_price IS NULL OR old_price > price)');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('items', 'items_old_price_gt_price_check');
  pgm.dropColumn('items', 'old_price');
};
