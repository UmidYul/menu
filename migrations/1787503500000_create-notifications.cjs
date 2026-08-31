/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('notifications', {
    id: 'id',
    channel: { type: 'text', notNull: true },
    recipient: { type: 'text', notNull: true },
    template: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    lang: { type: 'text', notNull: true, default: 'ru' },
    status: { type: 'text', notNull: true, default: 'pending' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
    scheduled_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    sent_at: { type: 'timestamptz' },
    dedup_key: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('notifications', 'notifications_channel_check', "CHECK (channel IN ('telegram', 'email'))");
  pgm.addConstraint(
    'notifications',
    'notifications_status_check',
    "CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))"
  );

  // Не даёт одному и тому же напоминанию уйти дважды (например, повторный enqueue того же
  // события). Ограничение снимается для 'failed' — если запись всё-таки не отправилась
  // насовсем, тот же dedup_key должен быть переиспользуем для новой попытки.
  pgm.createIndex('notifications', 'dedup_key', {
    unique: true,
    where: "dedup_key IS NOT NULL AND status <> 'failed'",
  });
  pgm.createIndex('notifications', ['status', 'scheduled_at']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('notifications');
};
