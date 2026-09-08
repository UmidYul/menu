/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // Промт 3.5: «Индикация, кто и когда последний раз менял позицию: "выключил Азиз, 14:20"».
  // Логин для этого не годится — он технический (aziz_waiter), а в зале человека зовут Азиз.
  // Nullable: у существующих владельцев имени нет и требовать его задним числом незачем,
  // интерфейс в этом случае показывает логин.
  pgm.addColumns('admins', {
    display_name: { type: 'text' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('admins', ['display_name']);
};
