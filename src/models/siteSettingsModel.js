const { pool } = require('../config/db');

// Единственная строка настроек (id=1, гарантирована миграцией) — контакты владельца сервиса
// для футера лендинга, не имеет отношения к venues.

async function get() {
  const result = await pool.query('SELECT * FROM site_settings WHERE id = 1');
  return result.rows[0];
}

async function update({
  ownerName, phone, phoneExtra, email, telegramUrl, instagramUrl,
  addressRu, addressUz, workingHoursRu, workingHoursUz, aboutRu, aboutUz,
  offerUrl, privacyUrl,
  paymentCardNumber, paymentCardHolder, paymentBankName,
  paymentInstructionsRu, paymentInstructionsUz, paymentInstructionsEn, printDomain,
}) {
  const result = await pool.query(
    `UPDATE site_settings
     SET owner_name = $1, phone = $2, phone_extra = $3, email = $4,
         telegram_url = $5, instagram_url = $6,
         address_ru = $7, address_uz = $8, working_hours_ru = $9, working_hours_uz = $10,
         about_ru = $11, about_uz = $12, offer_url = $13, privacy_url = $14,
         payment_card_number = $15, payment_card_holder = $16, payment_bank_name = $17,
         payment_instructions_ru = $18, payment_instructions_uz = $19, payment_instructions_en = $20,
         print_domain = $21,
         updated_at = now()
     WHERE id = 1
     RETURNING *`,
    [
      ownerName, phone, phoneExtra, email, telegramUrl, instagramUrl,
      addressRu, addressUz, workingHoursRu, workingHoursUz, aboutRu, aboutUz,
      offerUrl, privacyUrl,
      paymentCardNumber, paymentCardHolder, paymentBankName,
      paymentInstructionsRu, paymentInstructionsUz, paymentInstructionsEn, printDomain,
    ]
  );
  return result.rows[0];
}

module.exports = { get, update };
