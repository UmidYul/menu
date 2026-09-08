/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.5: start_url манифеста несёт метку источника, чтобы в аналитике было видно заходы
  // из установленного приложения отдельно от переходов по QR и ссылкам. Без расширения CHECK
  // такая метка молча ломала бы вставку события page_view.
  pgm.dropConstraint('menu_events', 'menu_events_source_check');
  pgm.addConstraint(
    'menu_events',
    'menu_events_source_check',
    "CHECK (source IS NULL OR source IN ('qr', 'link', 'social', 'direct', 'pwa'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  // Строки с источником pwa не удаляем, а обезличиваем до NULL: это настоящая статистика
  // просмотров, терять её ради отката ограничения незачем — source у события необязателен.
  pgm.sql("UPDATE menu_events SET source = NULL WHERE source = 'pwa'");
  pgm.dropConstraint('menu_events', 'menu_events_source_check');
  pgm.addConstraint(
    'menu_events',
    'menu_events_source_check',
    "CHECK (source IS NULL OR source IN ('qr', 'link', 'social', 'direct'))"
  );
};
