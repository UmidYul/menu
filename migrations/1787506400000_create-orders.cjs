/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('orders', {
    id: 'id',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    // Стол не FK-каскадится: заказ должен остаться читаемым, даже если стол потом удалили.
    // ON DELETE SET NULL плюс table_number_snapshot ниже — номер стола виден в истории всегда.
    table_id: { type: 'integer', references: 'venue_tables', onDelete: 'SET NULL' },
    table_number_snapshot: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'new' },
    total: { type: 'numeric(12,2)', notNull: true },
    currency: { type: 'text', notNull: true },
    comment: { type: 'text' },
    guest_lang: { type: 'text' },
    session_hash: { type: 'text' },
    // Случайный публичный токен для экрана статуса у гостя (/order/:slug/:token/status).
    // Последовательный id в URL позволил бы перебором смотреть чужие заказы — тот же принцип,
    // что и у токена стола выше.
    public_token: { type: 'text', notNull: true, unique: true },
    telegram_message_id: { type: 'bigint' },
    accepted_at: { type: 'timestamptz' },
    accepted_by_tg_id: { type: 'bigint' },
    cancel_reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint(
    'orders',
    'orders_status_check',
    "CHECK (status IN ('new', 'accepted', 'done', 'cancelled'))"
  );
  pgm.addConstraint('orders', 'orders_total_check', 'CHECK (total >= 0)');
  // Заказы заведения за период — админка/аналитика; свежие сверху.
  pgm.createIndex('orders', ['venue_id', 'created_at']);
  // Антиспам: "не больше 3 заказов с одного session_hash в час" считается этим индексом.
  pgm.createIndex('orders', ['session_hash', 'created_at']);

  pgm.createTable('order_items', {
    id: 'id',
    order_id: { type: 'integer', notNull: true, references: 'orders', onDelete: 'CASCADE' },
    // Позицию могли удалить из меню после заказа — ссылка обнуляется, но снимки ниже остаются:
    // заказ обязан читаться корректно и через полгода (промт 2.4).
    item_id: { type: 'integer', references: 'items', onDelete: 'SET NULL' },
    name_snapshot: { type: 'text', notNull: true },
    price_snapshot: { type: 'numeric(12,2)', notNull: true },
    qty: { type: 'integer', notNull: true },
    // [{ id, name, price_delta }] на момент заказа — тоже снимок, а не ссылки на item_options.
    options_snapshot: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    line_total: { type: 'numeric(12,2)', notNull: true },
  });

  pgm.addConstraint('order_items', 'order_items_qty_check', 'CHECK (qty > 0)');
  pgm.createIndex('order_items', 'order_id');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('order_items');
  pgm.dropTable('orders');
};
