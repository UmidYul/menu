/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.2. Сырые события живут 180 дней (чистит src/services/analyticsAggregation.js
  // из часового тика планировщика бота) — на них не вешаем FK на items/categories: позиция
  // могла быть удалена уже после события, событие всё равно должно остаться для агрегатов.
  // FK держим только на venues (событие без заведения бессмысленно, а заведения не удаляются
  // физически — см. venues.status='archived').
  pgm.createTable('menu_events', {
    id: 'bigserial',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    event_type: { type: 'text', notNull: true },
    // item_id/category_id/table_id намеренно без FK (см. коммент выше). table_id пока нигде
    // не проставляется — таблиц/заказов (промты 2.4/3.4) ещё нет, колонка ждёт их molча.
    item_id: { type: 'integer' },
    category_id: { type: 'integer' },
    table_id: { type: 'integer' },
    query: { type: 'text' },
    value: { type: 'numeric' },
    lang: { type: 'text' },
    source: { type: 'text' },
    // SHA-256(SESSION_SECRET + сутки + IP + User-Agent) — src/utils/sessionHash.js. Не сырые
    // IP/UA, см. раздел приватности в README.
    session_hash: { type: 'text', notNull: true },
    device: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Два индекса из промта: под "события заведения за период" (агрегация, дашборд) и под
  // "события заведения конкретного типа за период" (топ-листы конкретного event_type).
  pgm.createIndex('menu_events', ['venue_id', 'created_at']);
  pgm.createIndex('menu_events', ['venue_id', 'event_type', 'created_at']);

  pgm.addConstraint(
    'menu_events',
    'menu_events_event_type_check',
    `CHECK (event_type IN (
      'page_view', 'category_click', 'item_view', 'item_add', 'item_remove',
      'search', 'search_empty', 'cart_open', 'order_sent', 'waiter_call',
      'wifi_copy', 'share', 'review_prompt', 'review_submit', 'lang_switch'
    ))`
  );
  pgm.addConstraint('menu_events', 'menu_events_lang_check', "CHECK (lang IS NULL OR lang IN ('ru', 'uz', 'en'))");
  pgm.addConstraint(
    'menu_events',
    'menu_events_source_check',
    "CHECK (source IS NULL OR source IN ('qr', 'link', 'social', 'direct'))"
  );
  pgm.addConstraint(
    'menu_events',
    'menu_events_device_check',
    "CHECK (device IS NULL OR device IN ('mobile', 'tablet', 'desktop'))"
  );

  // Партиционирование по месяцам не делаем сейчас (180-дневное удаление пачками держит таблицу
  // в разумных пределах при текущих объёмах) — но если событий станет на порядки больше, первый
  // кандидат на PARTITION BY RANGE (created_at) именно эта таблица: вставки только в "текущий"
  // партишен, а удаление старых 180 дней превращается в DROP PARTITION вместо построчного DELETE.
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('menu_events');
};
