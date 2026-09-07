/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.4. telegram_chat_id — именно bigint: id супергрупп в Telegram отрицательные и
  // выходят за диапазон integer (-100xxxxxxxxxx).
  // telegram_chat_broken — «бота удалили из группы / он потерял право писать»: выставляется при
  // ошибке отправки (bot/worker/notifications.js), снимается при успешной переприязке. Отдельный
  // флаг, а не обнуление telegram_chat_id: владельцу нужно показать в админке ИМЕННО «связь
  // разорвана, переподключите», а не молча вернуть его к состоянию «ничего не привязано».
  // orders_enabled по умолчанию false — приём заказов включается осознанно (нужны и привязанная
  // группа, и готовность персонала), а не появляется сам у всех существующих заведений.
  // min_order_amount nullable — «по умолчанию не задана» из промта, а не 0.
  pgm.addColumns('venues', {
    telegram_chat_id: { type: 'bigint' },
    telegram_chat_title: { type: 'text' },
    telegram_linked_at: { type: 'timestamptz' },
    telegram_chat_broken: { type: 'boolean', notNull: true, default: false },
    orders_enabled: { type: 'boolean', notNull: true, default: false },
    min_order_amount: { type: 'numeric(12,2)' },
  });

  pgm.addConstraint(
    'venues',
    'venues_min_order_amount_check',
    'CHECK (min_order_amount IS NULL OR min_order_amount > 0)'
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('venues', 'venues_min_order_amount_check');
  pgm.dropColumns('venues', [
    'telegram_chat_id', 'telegram_chat_title', 'telegram_linked_at',
    'telegram_chat_broken', 'orders_enabled', 'min_order_amount',
  ]);
};
