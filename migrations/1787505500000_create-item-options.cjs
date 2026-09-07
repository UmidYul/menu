/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('item_options', {
    id: 'id',
    group_id: { type: 'integer', notNull: true, references: 'item_option_groups', onDelete: 'CASCADE' },
    name_ru: { type: 'text', notNull: true },
    name_uz: { type: 'text', notNull: true },
    name_en: { type: 'text' },
    price_delta: { type: 'numeric(12,2)', notNull: true, default: 0 },
    is_available: { type: 'boolean', notNull: true, default: true },
    is_default: { type: 'boolean', notNull: true, default: false },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });

  pgm.createIndex('item_options', 'group_id');
  // Только надбавка, не скидка — иначе легко получить отрицательную итоговую цену позиции.
  // "Маленькая порция дешевле базовой" решается тем, что базовой ценой делают маленькую.
  pgm.addConstraint('item_options', 'item_options_price_delta_check', 'CHECK (price_delta >= 0)');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('item_options');
};
