/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('item_option_groups', {
    id: 'id',
    item_id: { type: 'integer', notNull: true, references: 'items', onDelete: 'CASCADE' },
    // name_ru/name_uz NOT NULL — как у categories/items везде в проекте (ru+uz всегда
    // обязательны, en — нет); промт упоминает NOT NULL только для ru, но не отходим от
    // уже принятого во всём проекте правила двуязычного контента ради одной этой таблицы.
    name_ru: { type: 'text', notNull: true },
    name_uz: { type: 'text', notNull: true },
    name_en: { type: 'text' },
    selection: { type: 'text', notNull: true },
    is_required: { type: 'boolean', notNull: true, default: false },
    min_select: { type: 'integer', notNull: true, default: 0 },
    max_select: { type: 'integer' },
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });

  pgm.createIndex('item_option_groups', 'item_id');
  pgm.addConstraint(
    'item_option_groups',
    'item_option_groups_selection_check',
    "CHECK (selection IN ('single', 'multiple'))"
  );
  pgm.addConstraint('item_option_groups', 'item_option_groups_min_select_check', 'CHECK (min_select >= 0)');
  pgm.addConstraint(
    'item_option_groups',
    'item_option_groups_max_select_check',
    'CHECK (max_select IS NULL OR max_select >= min_select)'
  );
  // selection='single' — выбор ровно одного варианта, поэтому max_select=1 и min_select<=1
  // (0 допустим — необязательная single-группа, "без сиропа" по умолчанию).
  pgm.addConstraint(
    'item_option_groups',
    'item_option_groups_single_max_check',
    "CHECK (selection <> 'single' OR (max_select = 1 AND min_select <= 1))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('item_option_groups');
};
