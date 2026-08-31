/**
 * Действия по заявке, которые владелец сервиса совершает из бота (быстрое одобрение, отклонение),
 * не привязаны к вошедшему в веб-админку аккаунту — привязки Telegram к admins ещё нет (промт
 * 1.5). Тот же случай, что уже решался для site_settings в промте 0.1 (venue_id стал nullable) —
 * тут аналогично отвязываем admin_id, вместо того чтобы логировать действие под случайным
 * "первым попавшимся" суперадмином.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.alterColumn('admin_action_logs', 'admin_id', { notNull: false });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.alterColumn('admin_action_logs', 'admin_id', { notNull: true });
};
