/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Денормализованная копия admins.telegram_id того админа, который привязал аккаунт —
  // чтобы уведомлять заведение в Telegram без JOIN на admins из каждого места рассылки
  // (тот же приём, что owner_telegram_id у OWNER_TELEGRAM_IDS для сервиса в целом).
  pgm.addColumn('venues', {
    owner_telegram_id: { type: 'bigint' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumn('venues', 'owner_telegram_id');
};
