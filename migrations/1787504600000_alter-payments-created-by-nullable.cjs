/**
 * Подтверждение заявки на оплату кнопкой в Telegram (промт 1.4) не привязано к вошедшему в
 * веб-админку аккаунту — как и одобрение заявок на подключение из бота (промт 1.2, см.
 * 1787504100000). Тот же приём: created_by становится nullable, paymentModel.listByVenue
 * переходит на LEFT JOIN, чтобы такие платежи не выпадали из истории молча.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.alterColumn('payments', 'created_by', { notNull: false });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.alterColumn('payments', 'created_by', { notNull: true });
};
