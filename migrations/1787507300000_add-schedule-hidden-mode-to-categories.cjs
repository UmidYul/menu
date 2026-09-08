/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 2.3, раздел 3. Что делать с тем, что сейчас вне расписания:
  //   hide    — не показывать вовсе;
  //   dim     — показать приглушённым с подписью «доступно с 8:00 до 11:00», добавить нельзя;
  //   section — собрать всё недоступное по времени в отдельную секцию внизу.
  // По умолчанию dim: гость видит, что у заведения есть завтраки, и придёт утром — это ценнее,
  // чем спрятать (формулировка самого промта).
  // Режим живёт только у категории; для позиции со своим расписанием берётся режим её
  // категории — отдельная настройка на каждой позиции была бы способом получить пёстрое меню,
  // где часть блюд пропадает, а часть тускнеет, без единой причины для гостя.
  pgm.addColumns('categories', {
    schedule_hidden_mode: { type: 'text', notNull: true, default: 'dim' },
  });

  pgm.addConstraint(
    'categories',
    'categories_schedule_hidden_mode_check',
    "CHECK (schedule_hidden_mode IN ('hide', 'dim', 'section'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('categories', 'categories_schedule_hidden_mode_check');
  pgm.dropColumns('categories', ['schedule_hidden_mode']);
};
