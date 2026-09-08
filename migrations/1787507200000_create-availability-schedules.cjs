/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.3. Без полиморфизма (entity_type + entity_id) — две отдельные nullable-ссылки:
  // так работает настоящий внешний ключ с каскадом, и удаление категории/позиции само уносит
  // её расписания, а не оставляет висеть строки, на которые уже никто не смотрит.
  pgm.createTable('availability_schedules', {
    id: 'id',
    category_id: { type: 'integer', references: 'categories', onDelete: 'CASCADE' },
    item_id: { type: 'integer', references: 'items', onDelete: 'CASCADE' },
    // Дни недели по ISO: 1 = понедельник ... 7 = воскресенье. Тот же счёт, что у Postgres
    // isodow и у Intl с weekday — не приходится нигде конвертировать.
    days: { type: 'smallint[]', notNull: true },
    time_from: { type: 'time', notNull: true },
    time_to: { type: 'time', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
  });

  // Ровно одна из ссылок заполнена — иначе строка либо ничья, либо принадлежит двум сущностям
  // сразу, и приоритет «позиция важнее категории» перестаёт быть определённым.
  pgm.addConstraint(
    'availability_schedules',
    'availability_schedules_target_check',
    'CHECK ((category_id IS NULL) <> (item_id IS NULL))'
  );
  // Пустой массив дней означал бы «никогда» — такое расписание не нужно создавать, для этого
  // есть is_active. Значения вне 1..7 сломали бы сопоставление с текущим днём недели.
  pgm.addConstraint(
    'availability_schedules',
    'availability_schedules_days_check',
    'CHECK (array_length(days, 1) BETWEEN 1 AND 7 AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[])'
  );

  // Расписания всегда читаются пачкой на всё заведение (рендер меню) или по одной сущности
  // (форма в админке) — оба пути идут через эти две ссылки.
  pgm.createIndex('availability_schedules', ['category_id']);
  pgm.createIndex('availability_schedules', ['item_id']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('availability_schedules');
};
