/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.6: «admins.venue_id пометить как устаревшее, но НЕ удалять в этой же миграции.
  // Удалить отдельной миграцией после того, как код полностью переведён и проверен. Это защита
  // от невозможности отката».
  //
  // Комментарий в схеме, а не только в README: тот, кто через полгода откроет \d admins,
  // увидит пометку там же, где колонку, и не станет на неё опираться.
  //
  // Колонка при этом продолжает заполняться при создании администратора — до её удаления
  // откат кода к однозаведенческой версии должен оставаться возможным.
  pgm.sql(`
    COMMENT ON COLUMN admins.venue_id IS
      'УСТАРЕЛО (промт 3.6): доступ к заведениям определяется таблицей admin_venues. Колонка сохранена ради возможности отката и удаляется отдельной миграцией.'
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.sql('COMMENT ON COLUMN admins.venue_id IS NULL');
};
