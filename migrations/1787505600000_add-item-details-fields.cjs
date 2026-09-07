/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

const ALLERGENS = [
  'gluten', 'milk', 'eggs', 'nuts', 'peanuts', 'fish', 'seafood', 'soy', 'sesame', 'celery', 'mustard', 'sulphites',
];
const OLD_TAGS = ['halal', 'vegan', 'vegetarian', 'spicy', 'new'];
const NEW_TAGS = OLD_TAGS.concat(['lactose_free', 'gluten_free', 'chef_choice']);

function tagsCheck(tags) {
  return `CHECK (tags <@ ARRAY[${tags.map((t) => `'${t}'`).join(', ')}]::text[])`;
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('items', {
    weight_value: { type: 'numeric(8,2)' },
    weight_unit: { type: 'text' },
    cooking_time_minutes: { type: 'integer' },
    allergens: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    // Заменяет бинарный тег spicy (сам тег остаётся ради совместимости — промт 2.2).
    spicy_level: { type: 'smallint' },
    is_popular: { type: 'boolean', notNull: true, default: false },
  });

  pgm.addConstraint('items', 'items_weight_unit_check', "CHECK (weight_unit IS NULL OR weight_unit IN ('g', 'ml', 'pcs'))");
  pgm.addConstraint('items', 'items_weight_value_check', 'CHECK (weight_value IS NULL OR weight_value > 0)');
  pgm.addConstraint(
    'items',
    'items_cooking_time_check',
    'CHECK (cooking_time_minutes IS NULL OR cooking_time_minutes > 0)'
  );
  pgm.addConstraint(
    'items',
    'items_allergens_allowed_check',
    `CHECK (allergens <@ ARRAY[${ALLERGENS.map((a) => `'${a}'`).join(', ')}]::text[])`
  );
  pgm.addConstraint('items', 'items_spicy_level_check', 'CHECK (spicy_level IS NULL OR spicy_level BETWEEN 0 AND 3)');

  pgm.dropConstraint('items', 'items_tags_allowed_check');
  pgm.addConstraint('items', 'items_tags_allowed_check', tagsCheck(NEW_TAGS));

  // Разовый перенос: у кого стоял тег spicy — тому базовый уровень остроты 1, чтобы новая
  // шкала сразу отражала уже введённые данные, а не начиналась с пустого места.
  pgm.sql("UPDATE items SET spicy_level = 1 WHERE 'spicy' = ANY(tags) AND spicy_level IS NULL");
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  // Позиции с новыми тегами уронили бы возврат старого CHECK — сначала чистим сами теги.
  pgm.sql("UPDATE items SET tags = ARRAY(SELECT unnest(tags) INTERSECT SELECT unnest(ARRAY['halal','vegan','vegetarian','spicy','new']::text[]))");
  pgm.dropConstraint('items', 'items_tags_allowed_check');
  pgm.addConstraint('items', 'items_tags_allowed_check', tagsCheck(OLD_TAGS));

  pgm.dropConstraint('items', 'items_spicy_level_check');
  pgm.dropConstraint('items', 'items_allergens_allowed_check');
  pgm.dropConstraint('items', 'items_cooking_time_check');
  pgm.dropConstraint('items', 'items_weight_value_check');
  pgm.dropConstraint('items', 'items_weight_unit_check');

  pgm.dropColumns('items', [
    'weight_value', 'weight_unit', 'cooking_time_minutes', 'allergens', 'spicy_level', 'is_popular',
  ]);
};
