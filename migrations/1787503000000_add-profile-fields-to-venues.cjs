/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Профиль заведения для публичной карточки меню: обложка/лого, описание, теги
// "кухня / категория / район", email и рейтинг (выставляется вручную заведением —
// в сервисе нет системы отзывов, из которой рейтинг считался бы автоматически).

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('venues', {
    logo_url: { type: 'text' },
    logo_thumb_url: { type: 'text' },
    cover_url: { type: 'text' },
    cover_thumb_url: { type: 'text' },
    description_ru: { type: 'text' },
    description_uz: { type: 'text' },
    cuisine_ru: { type: 'text' },
    cuisine_uz: { type: 'text' },
    category_label_ru: { type: 'text' },
    category_label_uz: { type: 'text' },
    district_ru: { type: 'text' },
    district_uz: { type: 'text' },
    email: { type: 'text' },
    rating: { type: 'numeric(2,1)' },
    review_count: { type: 'integer' },
  });

  pgm.addConstraint('venues', 'venues_rating_range_check', 'CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5))');
  pgm.addConstraint('venues', 'venues_review_count_positive_check', 'CHECK (review_count IS NULL OR review_count >= 0)');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('venues', 'venues_rating_range_check');
  pgm.dropConstraint('venues', 'venues_review_count_positive_check');
  pgm.dropColumns('venues', [
    'logo_url',
    'logo_thumb_url',
    'cover_url',
    'cover_thumb_url',
    'description_ru',
    'description_uz',
    'cuisine_ru',
    'cuisine_uz',
    'category_label_ru',
    'category_label_uz',
    'district_ru',
    'district_uz',
    'email',
    'rating',
    'review_count',
  ]);
};
