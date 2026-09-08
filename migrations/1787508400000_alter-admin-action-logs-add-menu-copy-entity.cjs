/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.6, раздел 5: копирование меню из другого заведения. Своим entity_type, а не
  // 'category'/'item': копирование — ОДНО действие над меню целиком, и в журнале оно должно
  // читаться одной строкой («скопировано 8 категорий и 47 позиций из „Точки на Чиланзаре“»),
  // а не полусотней одинаковых create, среди которых не видно, что произошло.
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table', 'review', 'schedule', 'waiter_call', 'menu_copy'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.sql("DELETE FROM admin_action_logs WHERE entity_type = 'menu_copy'");
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table', 'review', 'schedule', 'waiter_call'))"
  );
};
