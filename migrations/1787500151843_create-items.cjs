/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('items', {
    id: 'id',
    category_id: {
      type: 'integer',
      notNull: true,
      references: 'categories',
      onDelete: 'RESTRICT',
    },
    name_ru: { type: 'text', notNull: true },
    name_uz: { type: 'text', notNull: true },
    description_ru: { type: 'text' },
    description_uz: { type: 'text' },
    price: { type: 'numeric(12,2)', notNull: true },
    currency: { type: 'text', notNull: true, default: 'UZS' },
    photo_url: { type: 'text' },
    photo_thumb_url: { type: 'text' },
    tags: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    is_available: { type: 'boolean', notNull: true, default: true },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });

  pgm.createIndex('items', 'category_id');
  pgm.addConstraint('items', 'items_price_positive_check', 'CHECK (price >= 0)');
  pgm.addConstraint(
    'items',
    'items_tags_allowed_check',
    "CHECK (tags <@ ARRAY['halal', 'vegan', 'vegetarian', 'spicy', 'new']::text[])"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('items');
};
