/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.4. number — text, а не integer: у заведений бывают «Терраса 3», «Бар 1», «VIP».
  // token — случайные 8 символов и UNIQUE глобально (а не только внутри заведения): в QR зашита
  // ссылка вида /menu/:slug?t=<token>, и предсказуемый «?table=7» позволил бы любому прохожему
  // вызвать официанта к любому столу или отправить фиктивный заказ.
  pgm.createTable('venue_tables', {
    id: 'id',
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'CASCADE' },
    number: { type: 'text', notNull: true },
    token: { type: 'text', notNull: true, unique: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    sort_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('venue_tables', 'venue_tables_venue_number_unique', 'UNIQUE (venue_id, number)');
  // Список столов заведения в админке и печать QR — всегда выборка по venue_id в порядке сортировки.
  pgm.createIndex('venue_tables', ['venue_id', 'sort_order']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('venue_tables');
};
