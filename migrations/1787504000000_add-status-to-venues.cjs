/**
 * Колонка тянется вперёд из промта 1.3 (полный жизненный цикл заведения) — она нужна уже
 * сейчас: одобренная заявка (промт 1.2) должна создавать заведение в статусе 'draft'. Остальная
 * механика жизненного цикла (даты триала, почасовой пересчёт, поведение публичной страницы
 * по статусу) в этом промте не реализуется — это полностью задача 1.3, который добавит
 * недостающие колонки (published_at, trial_started_at и т.д.) отдельной миграцией поверх этой.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumn('venues', {
    status: { type: 'text', notNull: true, default: 'active' },
  });

  pgm.addConstraint(
    'venues',
    'venues_status_check',
    "CHECK (status IN ('draft', 'trial', 'active', 'grace', 'suspended', 'archived'))"
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('venues', 'venues_status_check');
  pgm.dropColumn('venues', 'status');
};
