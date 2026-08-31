/**
 * venues.status (draft/trial/active/grace/suspended/archived) уже существует — заведён в промте
 * 1.2, пул-форвардом из этого промта, только сама колонка. Здесь — остальные поля жизненного
 * цикла и однократный бэкфилл published_at для уже существующих (не-draft) заведений: они с
 * точки зрения старой модели уже были "опубликованы" с момента создания, до draft/trial ничего
 * не различало.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('venues', {
    published_at: { type: 'timestamptz' },
    trial_started_at: { type: 'timestamptz' },
    trial_ends_on: { type: 'date' },
    suspended_at: { type: 'timestamptz' },
    archived_at: { type: 'timestamptz' },
    status_changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql("UPDATE venues SET published_at = created_at WHERE status <> 'draft'");
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('venues', [
    'published_at',
    'trial_started_at',
    'trial_ends_on',
    'suspended_at',
    'archived_at',
    'status_changed_at',
  ]);
};
