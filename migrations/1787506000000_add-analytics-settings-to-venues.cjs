/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.2: exclude_owner_views — переключатель «не учитывать мои просмотры» на странице
  // аналитики. По умолчанию включён (true) — сам промт называет фильтрацию своих просмотров
  // желаемым поведением ("исключай"), выключение — осознанное действие владельца, а не наоборот.
  // weekly_summary_enabled — включает/выключает еженедельную сводку в Telegram по понедельникам
  // (bot/worker/scheduler.js); включена по умолчанию для заведений с привязанным Telegram,
  // без привязки она и так не отправляется (см. checkWeeklyAnalyticsSummary).
  pgm.addColumns('venues', {
    exclude_owner_views: { type: 'boolean', notNull: true, default: true },
    weekly_summary_enabled: { type: 'boolean', notNull: true, default: true },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('venues', ['exclude_owner_views', 'weekly_summary_enabled']);
};
