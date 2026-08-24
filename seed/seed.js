const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEMO_SLUG = 'demo';

// Учётные данные только для локальной разработки — не использовать в проде.
const DEV_ADMINS = [
  { login: 'superadmin', password: 'superadmin123', role: 'superadmin', venueId: null },
  { login: 'venue_admin', password: 'venueadmin123', role: 'venue_admin', venueId: 'demo' },
];

// Заведение "demo" — постоянный фикстур, создаётся миграцией 1787502000000_seed-demo-venue.cjs
// (и наполняется меню миграцией 1787502500000_replace-demo-venue-menu.cjs), поэтому здесь только
// ищем его id, чтобы привязать dev-аккаунт venue_admin.
async function findDemoVenueId(client) {
  const existing = await client.query('SELECT id FROM venues WHERE slug = $1', [DEMO_SLUG]);
  if (existing.rows.length === 0) {
    throw new Error(`Заведение "${DEMO_SLUG}" не найдено — прогоните миграции (npm run migrate:up) перед сидированием.`);
  }
  return existing.rows[0].id;
}

async function seedAdmins(client, demoVenueId) {
  for (const admin of DEV_ADMINS) {
    const existing = await client.query('SELECT id FROM admins WHERE login = $1', [admin.login]);
    if (existing.rows.length > 0) {
      console.log(`Аккаунт "${admin.login}" уже существует, пропущено.`);
      continue;
    }

    const venueId = admin.venueId === 'demo' ? demoVenueId : null;
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
    const demoVenueId = await findDemoVenueId(client);
    await seedAdmins(client, demoVenueId);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Ошибка сидирования:', err);
  process.exit(1);
});
