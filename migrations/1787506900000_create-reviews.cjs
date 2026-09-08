/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('reviews', {
    id: 'id',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    rating: { type: 'smallint', notNull: true },
    comment: { type: 'text' },
    // Телефон или Telegram — необязательно; по нему владелец может связаться с гостем.
    contact: { type: 'text' },
    // Стол не каскадится: отзыв должен читаться и после удаления стола (как и заказ в 2.4).
    table_id: { type: 'integer', references: 'venue_tables', onDelete: 'SET NULL' },
    lang: { type: 'text' },
    session_hash: { type: 'text' },
    // Нажал ли гость кнопку перехода на карты. Именно НАЖАЛ: дошёл ли он и написал ли что-то
    // на Google/Яндексе, мы знать не можем — в админке это подписано честно.
    went_external: { type: 'boolean', notNull: true, default: false },
    external_target: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'new' },
    // Заметка владельца для себя (промт: «поле заметки для себя»), не показывается гостю.
    owner_reply: { type: 'text' },
    replied_at: { type: 'timestamptz' },
    // Промт: отзывы без текста и с одинаковым текстом подряд помечать подозрительными,
    // но НЕ удалять — решение принимает владелец, а не эвристика.
    is_suspicious: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('reviews', 'reviews_rating_check', 'CHECK (rating BETWEEN 1 AND 5)');
  pgm.addConstraint(
    'reviews',
    'reviews_status_check',
    "CHECK (status IN ('new', 'read', 'resolved', 'spam'))"
  );
  pgm.addConstraint(
    'reviews',
    'reviews_external_target_check',
    "CHECK (external_target IS NULL OR external_target IN ('google', 'yandex'))"
  );

  // Списки в админке и подсчёт среднего рейтинга — всегда по заведению.
  pgm.createIndex('reviews', ['venue_id', 'created_at']);
  // Бейдж «непрочитанные» и фильтр по статусу.
  pgm.createIndex('reviews', ['venue_id', 'status']);
  // Антинакрутка: «один session_hash — один отзыв в 30 дней».
  pgm.createIndex('reviews', ['session_hash', 'created_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('reviews');
};
