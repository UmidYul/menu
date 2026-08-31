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
    name_en: { type: 'text' },
    description_en: { type: 'text' },
    composition_en: { type: 'text' },
  });

  pgm.addColumns('categories', {
    name_en: { type: 'text' },
  });

  pgm.addColumns('venues', {
    description_en: { type: 'text' },
    cuisine_en: { type: 'text' },
    category_label_en: { type: 'text' },
    district_en: { type: 'text' },
    // Существующие заведения получают {ru,uz} дефолтом — их поведение не меняется, EN
    // включается вручную из venue-settings.
    enabled_langs: { type: 'text[]', notNull: true, default: pgm.func("'{ru,uz}'::text[]") },
  });

  pgm.addConstraint(
    'venues',
    'venues_enabled_langs_check',
    "CHECK (array_length(enabled_langs, 1) > 0 AND enabled_langs <@ ARRAY['ru','uz','en']::text[] AND lang_default = ANY(enabled_langs))"
  );

  pgm.dropConstraint('venues', 'venues_lang_default_check');
  pgm.addConstraint('venues', 'venues_lang_default_check', "CHECK (lang_default IN ('ru', 'uz', 'en'))");
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('venues', 'venues_lang_default_check');
  pgm.addConstraint('venues', 'venues_lang_default_check', "CHECK (lang_default IN ('ru', 'uz'))");

  pgm.dropConstraint('venues', 'venues_enabled_langs_check');

  pgm.dropColumns('venues', ['description_en', 'cuisine_en', 'category_label_en', 'district_en', 'enabled_langs']);
  pgm.dropColumns('categories', ['name_en']);
  pgm.dropColumns('items', ['name_en', 'description_en', 'composition_en']);
};
