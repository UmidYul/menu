/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('venues', {
    id: 'id',
    slug: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    address: { type: 'text' },
    address_2gis_url: { type: 'text' },
    working_hours: { type: 'jsonb' },
    instagram_url: { type: 'text' },
    telegram_url: { type: 'text' },
    lang_default: { type: 'text', notNull: true, default: 'ru' },
    is_active: { type: 'boolean', notNull: true, default: true },
    subscription_until: { type: 'date' },
    show_powered_by: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('venues', 'venues_lang_default_check', "CHECK (lang_default IN ('ru', 'uz'))");
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('venues');
};
