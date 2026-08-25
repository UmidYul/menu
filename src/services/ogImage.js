const sharp = require('sharp');

const WIDTH = 1200;
const HEIGHT = 630;

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));
}

// Длинные названия заведения не должны вылезать за пределы превью — чем длиннее имя,
// тем мельче кегль.
function nameFontSize(name) {
  if (name.length > 26) return 44;
  if (name.length > 18) return 54;
  return 68;
}

// Генерирует og:image для страницы меню заведения "на лету": инициал заведения на медальоне
// + название + бренд сервиса. Рендерится в SVG и растеризуется через sharp — не зависит от
// того, загружено ли у заведения хоть одно фото блюда.
async function renderVenueOgImage(venueName, serviceName) {
  const initial = escapeXml(venueName.trim().charAt(0).toUpperCase() || '?');
  const name = escapeXml(venueName);
  const fontSize = nameFontSize(venueName);
  const brand = escapeXml(serviceName);

  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${HEIGHT}" fill="#fffdf8"/>
      <circle cx="${WIDTH / 2}" cy="${HEIGHT / 2 - 260}" r="220" fill="#c65d4214"/>
      <circle cx="${WIDTH / 2}" cy="228" r="86" fill="#dce5d6"/>
      <text x="${WIDTH / 2}" y="258" font-family="Georgia, 'Playfair Display', serif" font-size="76" fill="#5a6a55" text-anchor="middle">${initial}</text>
      <text x="${WIDTH / 2}" y="392" font-family="Georgia, 'Playfair Display', serif" font-size="${fontSize}" fill="#27251f" text-anchor="middle">${name}</text>
      <text x="${WIDTH / 2}" y="440" font-family="Arial, sans-serif" font-size="24" letter-spacing="3" fill="#77756d" text-anchor="middle">ЦИФРОВОЕ МЕНЮ</text>
      <rect x="${WIDTH / 2 - 140}" y="478" width="280" height="1" fill="#e4e1d8"/>
      <text x="${WIDTH / 2}" y="524" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="#c65d42" text-anchor="middle">${brand}</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderVenueOgImage };
