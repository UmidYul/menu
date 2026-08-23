const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SLUG = 'test-cafe';

// Учётные данные только для локальной разработки — не использовать в проде.
const DEV_ADMINS = [
  { login: 'superadmin', password: 'superadmin123', role: 'superadmin', venueId: null },
  { login: 'venue_admin', password: 'venueadmin123', role: 'venue_admin', venueId: 'test-cafe' },
  { login: 'staff', password: 'staff123', role: 'staff', venueId: 'test-cafe' },
];

async function seedVenue(client) {
  const existing = await client.query('SELECT id FROM venues WHERE slug = $1', [SLUG]);
  if (existing.rows.length > 0) {
    console.log(`Тестовое заведение "${SLUG}" уже существует (id=${existing.rows[0].id}), сидирование меню пропущено.`);
    return existing.rows[0].id;
  }

  await client.query('BEGIN');
  try {
    const venueResult = await client.query(
      `INSERT INTO venues (slug, name, phone, address, address_2gis_url, working_hours, instagram_url, telegram_url, lang_default, is_active, show_powered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        SLUG,
        'Тестовое кафе',
        '+998901234567',
        'г. Ташкент, ул. Примерная, 1',
        'https://2gis.uz/tashkent',
        JSON.stringify({
          mon: '09:00-22:00',
          tue: '09:00-22:00',
          wed: '09:00-22:00',
          thu: '09:00-22:00',
          fri: '09:00-23:00',
          sat: '10:00-23:00',
          sun: '10:00-22:00',
        }),
        'https://instagram.com/test_cafe',
        'https://t.me/test_cafe',
        'ru',
        true,
        true,
      ]
    );
    const venueId = venueResult.rows[0].id;

    const drinksResult = await client.query(
      `INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
      [venueId, 'Напитки', 'Ichimliklar', 1]
    );
    const drinksId = drinksResult.rows[0].id;

    const foodResult = await client.query(
      `INSERT INTO categories (venue_id, name_ru, name_uz, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
      [venueId, 'Еда', 'Taomlar', 2]
    );
    const foodId = foodResult.rows[0].id;

    await client.query(
      `INSERT INTO items (category_id, name_ru, name_uz, description_ru, description_uz, price, currency, tags, is_available, sort_order)
       VALUES
        ($1, 'Капучино', 'Kapuchino', 'Классический капучино на молоке', 'Sutli klassik kapuchino', 25000, 'UZS', ARRAY['vegetarian']::text[], true, 1),
        ($1, 'Латте', 'Latte', 'Нежный латте', 'Nafis latte', 27000, 'UZS', ARRAY['vegetarian']::text[], true, 2),
        ($2, 'Плов', 'Osh', 'Узбекский плов с бараниной', 'Qo''y go''shtli o''zbek oshi', 45000, 'UZS', ARRAY['halal']::text[], true, 1),
        ($2, 'Салат овощной', 'Sabzavotli salat', 'Свежие сезонные овощи', 'Yangi mavsumiy sabzavotlar', 20000, 'UZS', ARRAY['vegan', 'new']::text[], false, 2)
       `,
      [drinksId, foodId]
    );

    await client.query('COMMIT');
    console.log(`Тестовое заведение "${SLUG}" (id=${venueId}) засеяно: 2 категории, 4 позиции.`);
    return venueId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function seedAdmins(client, testCafeVenueId) {
  for (const admin of DEV_ADMINS) {
    const existing = await client.query('SELECT id FROM admins WHERE login = $1', [admin.login]);
    if (existing.rows.length > 0) {
      console.log(`Аккаунт "${admin.login}" уже существует, пропущено.`);
      continue;
    }

    const venueId = admin.venueId === 'test-cafe' ? testCafeVenueId : null;
    const passwordHash = await bcrypt.hash(admin.password, 10);

    await client.query(
      'INSERT INTO admins (venue_id, login, password_hash, role) VALUES ($1, $2, $3, $4)',
      [venueId, admin.login, passwordHash, admin.role]
    );
    console.log(`Аккаунт "${admin.login}" (роль ${admin.role}) создан. Пароль (только для разработки): ${admin.password}`);
  }
}

async function seed() {
  const client = await pool.connect();
  try {
    const testCafeVenueId = await seedVenue(client);
    await seedAdmins(client, testCafeVenueId);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Ошибка сидирования:', err);
  process.exit(1);
});
