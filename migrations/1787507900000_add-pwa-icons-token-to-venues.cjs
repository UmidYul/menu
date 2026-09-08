/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.5. Иконки PWA (192, 512 и maskable 512) генерируются из логотипа заведения через
  // sharp и лежат рядом с остальными его файлами в /uploads/<venue_id>/.
  //
  // Одна колонка с общим префиксом имени файла, а не три отдельных URL: все три иконки всегда
  // появляются и исчезают вместе, и хранить три строки, которые обязаны быть согласованы, —
  // это три способа рассинхронизироваться вместо одного значения. NULL означает «иконок нет,
  // манифест отдаёт иконку сервиса».
  pgm.addColumns('venues', {
    pwa_icons_token: { type: 'text' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('venues', ['pwa_icons_token']);
};
