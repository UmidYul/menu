const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Неожиданная ошибка на неактивном клиенте PostgreSQL', err);
});

module.exports = { pool };
