/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.5: «Все действия staff логируются в admin_action_logs с указанием, кто именно».
  // Подтверждение вызова официанта — такое действие, и ему нужен свой entity_type.
  // action_type расширять не пришлось: create/update/delete/toggle_availability покрывают
  // всё, что staff и управление сотрудниками вообще делают.
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table', 'review', 'schedule', 'waiter_call'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.sql("DELETE FROM admin_action_logs WHERE entity_type = 'waiter_call'");
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin', 'table', 'review', 'schedule'))"
  );
};
