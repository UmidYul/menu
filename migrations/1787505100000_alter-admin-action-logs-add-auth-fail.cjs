/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_action_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_action_type_check',
    "CHECK (action_type IN ('create', 'update', 'delete', 'toggle_availability', 'auth_fail'))"
  );

  // 'admin' был в списке между миграциями 1787501524113 и 1787502900000, затем случайно потерян —
  // возвращаем его: он нужен для записей о смене пароля, привязке Telegram и auth_fail.
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead', 'admin'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_action_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_action_type_check',
    "CHECK (action_type IN ('create', 'update', 'delete', 'toggle_availability'))"
  );

  pgm.dropConstraint('admin_action_logs', 'admin_action_logs_entity_type_check');
  pgm.addConstraint(
    'admin_action_logs',
    'admin_action_logs_entity_type_check',
    "CHECK (entity_type IN ('item', 'category', 'venue', 'payment', 'site_settings', 'lead'))"
  );
};
