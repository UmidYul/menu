/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Промт 3.5. Роль 'staff' возвращается в продукт — но с гораздо более узким набором прав, чем
// та, что была удалена миграцией 1787502100000_remove-staff-role.cjs. Саму ту миграцию не
// трогаем (она давно применена): здесь просто заново расширяем оба CHECK.
//
// Права роли живут не в схеме, а в явном белом списке маршрутов (src/middlewares/staffAccess.js):
// в БД у staff ровно те же поля, что у venue_admin, а всё различие — в том, куда его пускают.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.up = async (pgm) => {
  await pgm.db.query('ALTER TABLE admins DROP CONSTRAINT admins_role_check');
  await pgm.db.query('ALTER TABLE admins DROP CONSTRAINT admins_role_venue_id_check');
  await pgm.db.query("ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('superadmin', 'venue_admin', 'staff'))");
  // staff, как и venue_admin, всегда привязан к заведению: сотрудника «вообще», без места
  // работы, не бывает, и без venue_id проверка «своё заведение» не имела бы к чему цепляться.
  await pgm.db.query(
    `ALTER TABLE admins ADD CONSTRAINT admins_role_venue_id_check
     CHECK ((role = 'superadmin' AND venue_id IS NULL) OR (role IN ('venue_admin', 'staff') AND venue_id IS NOT NULL))`
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void>}
 */
exports.down = async (pgm) => {
  // Откат обязан снести staff-аккаунты, иначе суженный CHECK не применится. Сначала аудит:
  // admin_action_logs.admin_id — ON DELETE RESTRICT.
  await pgm.db.query("DELETE FROM admin_action_logs WHERE admin_id IN (SELECT id FROM admins WHERE role = 'staff')");
  await pgm.db.query("DELETE FROM admins WHERE role = 'staff'");
  await pgm.db.query('ALTER TABLE admins DROP CONSTRAINT admins_role_venue_id_check');
  await pgm.db.query('ALTER TABLE admins DROP CONSTRAINT admins_role_check');
  await pgm.db.query("ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('superadmin', 'venue_admin'))");
  await pgm.db.query(
    `ALTER TABLE admins ADD CONSTRAINT admins_role_venue_id_check
     CHECK ((role = 'superadmin' AND venue_id IS NULL) OR (role = 'venue_admin' AND venue_id IS NOT NULL))`
  );
};
