const crypto = require('crypto');

// Без похожих на письме/экране символов (0/O, l/1/I) — такой пароль можно продиктовать
// по телефону без "О большое или ноль?".
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generatePassword(length = 12) {
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return result;
}

module.exports = { generatePassword };
