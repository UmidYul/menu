/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.5: официант подтверждает вызов с телефона, из своего кабинета, а не только кнопкой
  // в Telegram-группе. Существующая acknowledged_by_tg_id остаётся для подтверждений из бота —
  // это разные каналы, и складывать их в одну колонку значило бы потерять, откуда пришёл ответ.
  // SET NULL, а не CASCADE: уволенный сотрудник не должен уносить с собой историю вызовов.
  pgm.addColumns('waiter_calls', {
    acknowledged_by_admin_id: { type: 'integer', references: 'admins', onDelete: 'SET NULL' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('waiter_calls', ['acknowledged_by_admin_id']);
};
