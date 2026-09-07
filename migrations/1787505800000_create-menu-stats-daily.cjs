/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.2. Один агрегат = одна строка: (метрика, измерение) на день на заведение —
  // например metric='item_view', dimension='<item_id>', value=17, или metric='hourly_views',
  // dimension='14' (час суток), или metric='search_empty', dimension='пицца'. Схема "metric +
  // dimension" вместо отдельной колонки под каждый срез — новый разрез аналитики добавляется
  // без новой миграции, дашборд просто читает и группирует по нужному metric.
  pgm.createTable('menu_stats_daily', {
    id: 'bigserial',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    stat_on: { type: 'date', notNull: true },
    metric: { type: 'text', notNull: true },
    dimension: { type: 'text', notNull: true, default: '' },
    value: { type: 'numeric', notNull: true, default: 0 },
  });

  // dimension участвует в UNIQUE, поэтому NOT NULL DEFAULT '' (см. выше) — NULL в UNIQUE
  // не считался бы дубликатом сам с собой, и UPSERT по ON CONFLICT перестал бы находить
  // существующую строку метрик без измерения (page_view и т.п.).
  // Отдельный индекс под "метрика заведения за период" не нужен: UNIQUE-ограничение ниже
  // создаёт btree-индекс (venue_id, stat_on, metric, dimension), а его левый префикс
  // (venue_id, stat_on) Postgres использует и для более узких запросов дашборда.
  pgm.addConstraint(
    'menu_stats_daily',
    'menu_stats_daily_unique',
    'UNIQUE (venue_id, stat_on, metric, dimension)'
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('menu_stats_daily');
};
