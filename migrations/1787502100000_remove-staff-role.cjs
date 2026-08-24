/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Роль 'staff' убрана из продукта целиком (ограниченный доступ "только переключение наличия"
// был отдельной ролью — теперь такого пользователя в системе не бывает). Удаляем существующие
// staff-аккаунты и сужаем CHECK-констрейнты admins, чтобы новые такие записи стали невозможны.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.up = async (pgm) => {
  // admin_action_logs.admin_id — RESTRICT, поэтому сначала стираем историю аудита staff-аккаунтов.
  await pgm.db.query("DELETE FROM admin_action_logs WHERE admin_id IN (SELECT id FROM admins WHERE role = 'staff')");
  await pgm.db.query("DELETE FROM admins WHERE role = 'staff'");
  await pgm.db.query('ALTER TABLE admins DROP CONSTRAINT admins_role_check');
  await pgm.db.query('ALTER TABLE admins DROP CONSTRAINT admins_role_venue_id_check');
  await pgm.db.query("ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('superadmin', 'venue_admin'))");
  await pgm.db.query(
    `ALTER TABLE admins ADD CONSTRAINT admins_role_venue_id_check
     CHECK ((role = 'superadmin' AND venue_id IS NULL) OR (role = 'venue_admin' AND venue_id IS NOT NULL))`
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.down = async (pgm) => {
  await pgm.db.query('ALTER TABLE admins DROP CONSTRAINT admins_role_venue_id_check');
  await pgm.db.query('ALTER TABLE admins DROP CONSTRAINT admins_role_check');
  await pgm.db.query("ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('superadmin', 'venue_admin', 'staff'))");
  await pgm.db.query(
    `ALTER TABLE admins ADD CONSTRAINT admins_role_venue_id_check
     CHECK ((role = 'superadmin' AND venue_id IS NULL) OR (role IN ('venue_admin', 'staff') AND venue_id IS NOT NULL))`
  );
};
