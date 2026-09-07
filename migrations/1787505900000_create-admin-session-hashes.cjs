/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.2, edge case «владелец сам открывает своё меню и накручивает просмотры». На каждый
  // запрос авторизованного venue_admin (src/middlewares/auth.js) пишем тот же session_hash, что
  // считался бы для этого запроса как для гостя (SHA-256(SESSION_SECRET + сутки + IP + UA)).
  // Аналитика с включённым venues.exclude_owner_views исключает события menu_events, чей
  // session_hash+день нашёлся здесь для этого заведения — тем самым исключается не "сессия
  // админки", а конкретное сочетание IP+UA+день, с которого приходили и админские, и гостевые
  // запросы (ровно то приближение, которое просит промт: "не идеально, но снимает основную
  // часть шума").
  pgm.createTable('admin_session_hashes', {
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    session_hash: { type: 'text', notNull: true },
    occurred_on: { type: 'date', notNull: true },
  });

  pgm.addConstraint(
    'admin_session_hashes',
    'admin_session_hashes_pkey',
    'PRIMARY KEY (venue_id, session_hash, occurred_on)'
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('admin_session_hashes');
};
