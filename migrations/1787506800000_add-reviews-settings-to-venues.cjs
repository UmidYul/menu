/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.3. address_2gis_url НЕ трогаем — это ссылка «как доехать» из карточки заведения,
  // к отзывам отношения не имеет (промт отдельно на этом настаивает).
  //
  // reviews_enabled по умолчанию false: сбор отзывов включается осознанно, вместе со ссылками
  // на карты, а не появляется сам у всех существующих заведений.
  // reviews_threshold — оценка, начиная с которой гостю показывается экран благодарности
  // с кнопками на карты; ниже — сначала приватное поле для владельца.
  pgm.addColumns('venues', {
    google_review_url: { type: 'text' },
    yandex_review_url: { type: 'text' },
    reviews_enabled: { type: 'boolean', notNull: true, default: false },
    reviews_prompt_delay_sec: { type: 'integer', notNull: true, default: 45 },
    reviews_threshold: { type: 'smallint', notNull: true, default: 4 },
  });

  pgm.addConstraint(
    'venues',
    'venues_reviews_threshold_check',
    'CHECK (reviews_threshold BETWEEN 1 AND 5)'
  );
  // Задержка приглашения: ноль допустим («показать сразу»), отрицательная — нет.
  // Верхняя граница — час: больше означает «фактически никогда», для этого есть выключатель.
  pgm.addConstraint(
    'venues',
    'venues_reviews_delay_check',
    'CHECK (reviews_prompt_delay_sec >= 0 AND reviews_prompt_delay_sec <= 3600)'
  );
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('venues', 'venues_reviews_delay_check');
  pgm.dropConstraint('venues', 'venues_reviews_threshold_check');
  pgm.dropColumns('venues', [
    'google_review_url', 'yandex_review_url', 'reviews_enabled',
    'reviews_prompt_delay_sec', 'reviews_threshold',
  ]);
};
