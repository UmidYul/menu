/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.6 помечает это как опциональное («нужна для будущей сводной аналитики»). Делаю
  // сразу: таблица маленькая, а без неё сводный экран пришлось бы переделывать при появлении
  // сетей из нескольких юрлиц — сейчас «сеть» выводится из списка заведений администратора,
  // и этого хватает, но группа даёт ей имя и владельца.
  pgm.createTable('venue_groups', {
    id: 'id',
    name: { type: 'text', notNull: true },
    owner_admin_id: { type: 'integer', references: 'admins', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // SET NULL: расформирование группы не должно уносить сами заведения.
  pgm.addColumns('venues', {
    group_id: { type: 'integer', references: 'venue_groups', onDelete: 'SET NULL' },
  });
  pgm.createIndex('venues', 'group_id');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('venues', ['group_id']);
  pgm.dropTable('venue_groups');
};
