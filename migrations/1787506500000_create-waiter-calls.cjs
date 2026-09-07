/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.4, раздел 4. Имени таблицы в промте нет — заводим по аналогии с orders.
  // Кулдаун "один вызов со стола в 2 минуты" проверяется запросом по (table_id, created_at),
  // а не счётчиком в памяти процесса: так он переживает рестарт веб-процесса и не разъезжается,
  // как и остальные дедупликации в проекте (notifications.dedup_key, payment_claims и т.п.).
  pgm.createTable('waiter_calls', {
    id: 'id',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    table_id: { type: 'integer', references: 'venue_tables', onDelete: 'SET NULL' },
    table_number_snapshot: { type: 'text' },
    call_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'new' },
    session_hash: { type: 'text' },
    guest_lang: { type: 'text' },
    telegram_message_id: { type: 'bigint' },
    acknowledged_at: { type: 'timestamptz' },
    acknowledged_by_tg_id: { type: 'bigint' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint(
    'waiter_calls',
    'waiter_calls_call_type_check',
    "CHECK (call_type IN ('come', 'bill', 'cutlery'))"
  );
  pgm.addConstraint(
    'waiter_calls',
    'waiter_calls_status_check',
    "CHECK (status IN ('new', 'acknowledged'))"
  );

  // Кулдаун по столу.
  pgm.createIndex('waiter_calls', ['table_id', 'created_at']);
  // Антиспам "10 вызовов с одного session_hash в час".
  pgm.createIndex('waiter_calls', ['session_hash', 'created_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('waiter_calls');
};
