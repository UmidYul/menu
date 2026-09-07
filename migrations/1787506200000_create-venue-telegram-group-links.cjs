/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.4. Отдельная таблица от venue_telegram_links (промт 1.5) намеренно: там привязывается
  // ЛИЧНЫЙ аккаунт админа через deep-link /start link_<code> (claim по ctx.from.id), здесь —
  // ГРУППОВОЙ чат, код отправляется обычным сообщением в саму группу (claim по ctx.chat.id).
  // Общего у них только форма "код + TTL + одноразовое погашение", а смысл, точка погашения и
  // то, что записывается в venues, — разные; складывать их в одну таблицу с дискриминатором
  // значило бы смешать две разные сущности ради экономии на одной таблице.
  pgm.createTable('venue_telegram_group_links', {
    id: 'id',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    // Кто из админов заведения запросил код — только для аудита; на погашение не влияет
    // (в группе код вводит кто угодно, у бота нет способа связать его с админом).
    created_by_admin_id: { type: 'integer', references: 'admins', onDelete: 'SET NULL' },
    code: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Поиск при погашении всегда идёт по коду.
  pgm.createIndex('venue_telegram_group_links', 'code');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('venue_telegram_group_links');
};
