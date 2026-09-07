/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.4: управление столами (создание/переименование/деактивация/перевыпуск токена) —
  // действия администратора заведения и должны попадать в журнал, а entity_type ограничен
  // CHECK'ом. Сами заказы и вызовы официанта сюда НЕ добавляются: их создаёт гость, а не
  // администратор, admin_action_logs — журнал именно админских действий.
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  // Записи с entity_type='table' сначала убираем, иначе старый CHECK не применится.
  pgm.sql("DELETE FROM admin_action_logs WHERE entity_type = 'table'");
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin'))"
  );
};
