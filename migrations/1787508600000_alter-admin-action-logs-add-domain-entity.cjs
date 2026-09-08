/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.7. Добавление, перепроверка и отключение своего домена — действия владельца
  // над заведением, и в журнале они должны быть отличимы от правки настроек: домен уводит
  // на себя весь публичный трафик заведения, и «кто и когда его подключил» — вопрос, который
  // однажды зададут.
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table', 'review', 'schedule', 'waiter_call', 'menu_copy', 'domain'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.sql("DELETE FROM admin_action_logs WHERE entity_type = 'domain'");
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table', 'review', 'schedule', 'waiter_call', 'menu_copy'))"
  );
};
