/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.3: расписание доступности меняет то, что видит гость, — это такое же изменение
  // меню, как правка цены, и должно попадать в журнал действий администратора.
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table', 'review', 'schedule'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.sql("DELETE FROM admin_action_logs WHERE entity_type = 'schedule'");
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table', 'review'))"
  );
};
