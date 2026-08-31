/**
 * Реквизиты для ручной оплаты переводом на карту — правит суперадмин из своей панели, без
 * деплоя. payment_provider — задел под промт 1.4, раздел "Готовность к автоматической оплате":
 * пока единственное значение 'manual', переключение на click/payme — замена одного модуля
 * (src/services/payment/providers/manual.js), не миграция и не переписывание вызывающего кода.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('site_settings', {
    payment_card_number: { type: 'text' },
    payment_card_holder: { type: 'text' },
    payment_bank_name: { type: 'text' },
    payment_instructions_ru: { type: 'text' },
    payment_instructions_uz: { type: 'text' },
    payment_instructions_en: { type: 'text' },
    payment_provider: { type: 'text', notNull: true, default: 'manual' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('site_settings', [
    'payment_card_number',
    'payment_card_holder',
    'payment_bank_name',
    'payment_instructions_ru',
    'payment_instructions_uz',
    'payment_instructions_en',
    'payment_provider',
  ]);
};
