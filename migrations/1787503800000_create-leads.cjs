/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('leads', {
    id: 'id',
    source: { type: 'text', notNull: true },
    telegram_id: { type: 'bigint' },
    telegram_username: { type: 'text' },
    contact_name: { type: 'text', notNull: true },
    phone: { type: 'text', notNull: true },
    email: { type: 'text' },
    venue_name: { type: 'text', notNull: true },
    city: { type: 'text' },
    venue_type: { type: 'text' },
    comment: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'new' },
    reject_reason: { type: 'text' },
    venue_id: {
      type: 'integer',
      references: 'venues',
      onDelete: 'SET NULL',
    },
    processed_by: {
      type: 'integer',
      references: 'admins',
    },
    processed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ip_hash: { type: 'text' },
    user_agent: { type: 'text' },
  });

  pgm.addConstraint('leads', 'leads_source_check', "CHECK (source IN ('bot', 'web'))");
  pgm.addConstraint(
    'leads',
    'leads_status_check',
    "CHECK (status IN ('new', 'contacted', 'approved', 'rejected', 'spam'))"
  );

  pgm.createIndex('leads', ['status', 'created_at']);
  // "Один Telegram-аккаунт = одно заведение": пока заявка активна (не отклонена/не спам),
  // повторную из того же telegram_id создать нельзя — за это отвечает индекс, а не только
  // проверка в коде, чтобы гонка двух одновременных заявок не проскочила мимо.
  pgm.createIndex('leads', 'telegram_id', {
    unique: true,
    where: "status IN ('new', 'contacted', 'approved')",
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('leads');
};
