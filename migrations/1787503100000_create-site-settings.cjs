/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Контакты владельца сервиса (не заведения) для футера лендинга — редактируются только
// суперадмином на /superadmin/site-settings. Таблица физически хранит ровно одну строку
// (id=1, CHECK), приложение никогда не создаёт и не удаляет записи, только читает/обновляет id=1.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('site_settings', {
    id: { type: 'integer', notNull: true, primaryKey: true },
    owner_name: { type: 'text' },
    phone: { type: 'text' },
    phone_extra: { type: 'text' },
    email: { type: 'text' },
    telegram_url: { type: 'text' },
    instagram_url: { type: 'text' },
    address_ru: { type: 'text' },
    address_uz: { type: 'text' },
    working_hours_ru: { type: 'text' },
    working_hours_uz: { type: 'text' },
    about_ru: { type: 'text' },
    about_uz: { type: 'text' },
    offer_url: { type: 'text' },
    privacy_url: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('site_settings', 'site_settings_single_row_check', 'CHECK (id = 1)');

  pgm.sql('INSERT INTO site_settings (id) VALUES (1)');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('site_settings');
};
