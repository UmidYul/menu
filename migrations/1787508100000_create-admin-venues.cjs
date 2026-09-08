/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Промт 3.6. Связь «администратор — заведение» становится многие-ко-многим: сети из двух-трёх
// точек не помещаются в admins.venue_id.
//
// Роль теперь живёт НА ПАРЕ (администратор, заведение), а не глобально: один человек может быть
// owner в одном заведении и manager в другом. Глобальная admins.role остаётся типом аккаунта
// (superadmin против пользователя заведения) — это разные вещи, и складывать их в одну колонку
// значило бы потерять одну из них.
//
// Всё написано через pgm.* (включая перенос данных и проверку), а не через pgm.db.query:
// builder-вызовы node-pg-migrate ставятся в очередь и выполняются в конце, а db.query бьёт
// в базу немедленно — их смешивание даёт «relation does not exist» на собственной же таблице.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.createTable('admin_venues', {
    admin_id: { type: 'integer', notNull: true, references: 'admins', onDelete: 'CASCADE' },
    // RESTRICT, а не CASCADE: заведение с живыми администраторами не должно удаляться незаметно.
    // Это согласовано с admins.venue_id_fkey, который тоже RESTRICT.
    venue_id: { type: 'integer', notNull: true, references: 'venues', onDelete: 'RESTRICT' },
    role: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('admin_venues', 'admin_venues_pkey', { primaryKey: ['admin_id', 'venue_id'] });
  pgm.addConstraint(
    'admin_venues',
    'admin_venues_role_check',
    "CHECK (role IN ('owner', 'manager', 'staff'))"
  );

  // Список заведений администратора собирается на каждый вход и на каждое переключение —
  // индекс по admin_id обязателен. Обратный индекс (по заведению) нужен для «кто имеет доступ
  // к этому заведению» в суперадминке.
  pgm.createIndex('admin_venues', 'admin_id');
  pgm.createIndex('admin_venues', 'venue_id');

  // --- перенос существующих связей ---------------------------------------------------------
  // venue_admin становится owner (он и был единственным владельцем своего заведения),
  // staff остаётся staff. Суперадмин к заведениям не привязан вовсе и сюда не попадает.
  pgm.sql(`
    INSERT INTO admin_venues (admin_id, venue_id, role, created_at)
    SELECT a.id, a.venue_id,
           CASE WHEN a.role = 'staff' THEN 'staff' ELSE 'owner' END,
           a.created_at
    FROM admins a
    WHERE a.venue_id IS NOT NULL
    ON CONFLICT (admin_id, venue_id) DO NOTHING
  `);

  // Промт: «Проверить, что перенеслись все, прежде чем что-либо удалять». Проверка внутри той же
  // очереди — DO-блоком, который бросает исключение при расхождении. Миграция идёт в транзакции,
  // поэтому исключение откатит и создание таблицы. Молча потерять связь администратора с его
  // заведением нельзя: это потеря доступа к бизнесу, а не строчка в таблице.
  pgm.sql(`
    DO $$
    DECLARE
      expected_count bigint;
      migrated_count bigint;
    BEGIN
      SELECT count(*) INTO expected_count FROM admins WHERE venue_id IS NOT NULL;
      SELECT count(*) INTO migrated_count FROM admin_venues;
      IF expected_count <> migrated_count THEN
        RAISE EXCEPTION
          'Перенос связей admin->venue не сошёлся: ожидалось %, перенесено %. Миграция откачена.',
          expected_count, migrated_count;
      END IF;
    END
    $$;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  // admins.venue_id в этой миграции не трогался и остался на месте, поэтому откат безопасен:
  // приложение вернётся к одному заведению на аккаунт без потери данных.
  pgm.dropTable('admin_venues');
};
