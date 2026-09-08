// Промт 2.5. Разовая генерация запасных иконок PWA — тех, что подставляются в манифест
// заведения, у которого нет своего логотипа:
//   node scripts/build-service-icons.js
//
// Результат коммитится в src/public/icons/ и раздаётся статикой. Генерировать их на каждый
// запрос незачем: они одинаковы для всего сервиса и меняются только вместе с брендом.
//
// Марка взята из src/views/partials/brand.ejs — тот же stroke-based знак, что стоит в шапке.
// src/public/favicon.svg для этого не годится: там до сих пор лежит логотип из скаффолда,
// к бренду qr.menu отношения не имеющий.
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, '..', 'src', 'public', 'icons');

// Значения — те же, что у токенов дизайн-системы (--paper, --primary): в PNG переменные
// не работают, поэтому они здесь литералами и обязаны меняться вместе с design-system.css.
const BACKGROUND = '#fffdf8';
const PRIMARY = '#c65d42';

// Знак нарисован в системе координат 24x24 (как в brand.ejs). scale — во сколько раз он
// занимает холст: у обычной иконки почти весь, у maskable — 80%, потому что Android обрезает
// её по своей форме, и всё за пределами безопасной зоны просто исчезнет.
function iconSvg(size, { maskable }) {
  const glyphScale = maskable ? 0.56 : 0.68;
  const glyph = size * glyphScale;
  const offset = (size - glyph) / 2;
  const stroke = Math.max(1.2, 24 * 0.085);
  const radius = maskable ? 0 : size * 0.22;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${BACKGROUND}"/>
  <g transform="translate(${offset} ${offset}) scale(${glyph / 24})"
     fill="none" stroke="${PRIMARY}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1"></rect>
    <rect x="14" y="3" width="7" height="7" rx="1"></rect>
    <rect x="3" y="14" width="7" height="7" rx="1"></rect>
    <path d="M14 14h3v3h-3zM14 21h3M21 14v3M18 21h3v-3"></path>
  </g>
</svg>`;
}

async function render(name, size, options) {
  const svg = iconSvg(size, options);
  const file = path.join(OUT_DIR, name);
  await sharp(Buffer.from(svg)).png().toFile(file);
  const stat = await fs.stat(file);
  console.log(`  ${name} — ${size}x${size}, ${Math.round(stat.size / 102.4) / 10} КБ`);
}

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log('Иконки сервиса:');
  await render('app-192.png', 192, { maskable: false });
  await render('app-512.png', 512, { maskable: false });
  await render('app-maskable-512.png', 512, { maskable: true });
  console.log('готово');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
