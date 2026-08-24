/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('items', {
    composition_ru: { type: 'text' },
    composition_uz: { type: 'text' },
    calories: { type: 'integer' },
  });

  pgm.addConstraint('items', 'items_calories_positive_check', 'CHECK (calories IS NULL OR calories >= 0)');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('items', 'items_calories_positive_check');
  pgm.dropColumns('items', ['composition_ru', 'composition_uz', 'calories']);
};
