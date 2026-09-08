/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Домен сервиса, который печатается внизу QR-макетов (промт 3.4). Живёт в site_settings,
  // а не в venues и не в .env: это НАШ адрес, один на весь сервис (как owner_name и offer_url
  // рядом), и менять его должен суперадмин через интерфейс, без правки конфига и перезапуска.
  // Пустое значение — валидный случай: пока домен не куплен, в макетах просто ничего не печатается.
  pgm.addColumns('site_settings', {
    print_domain: { type: 'text' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('site_settings', ['print_domain']);
};
