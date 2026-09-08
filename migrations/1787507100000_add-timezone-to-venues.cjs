/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.3. Расписание доступности считается в часовом поясе ЗАВЕДЕНИЯ, а не сервера:
  // сервер может стоять в UTC или быть настроен неверно, и тогда завтраки закончатся в 6 утра.
  // Все заведения сейчас в Узбекистане, поэтому дефолт Asia/Tashkent, но зашивать его
  // в код нельзя — это данные заведения, а не константа сервиса.
  // Значение — идентификатор IANA; валидируется в приложении через Intl.supportedValuesOf,
  // а не CHECK-ом в БД: список зон живёт в ICU и меняется с обновлениями, прибивать его
  // гвоздями в схему нельзя.
  pgm.addColumns('venues', {
    timezone: { type: 'text', notNull: true, default: 'Asia/Tashkent' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('venues', ['timezone']);
};
