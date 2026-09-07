/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('venues', {
    // Проставляется только явным действием "Скачать" (промт 1.6) — не при обычном показе
    // QR-картинки на дашборде (тот же /admin/qr.png, но без ?download=1).
    qr_downloaded_at: { type: 'timestamptz' },
    // Проставляется переходом через /admin/preview-menu — единственный способ увидеть
    // публичную страницу черновика (см. изменения в publicMenu.js).
    menu_previewed_at: { type: 'timestamptz' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('venues', ['qr_downloaded_at', 'menu_previewed_at']);
};
