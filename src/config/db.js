const { Pool, types } = require('pg');
const env = require('./env');

// DATE-колонки (OID 1082) node-postgres по умолчанию парсит в JS Date по местному времени
// процесса — при серверном времени, отличном от UTC (сессия БД работает в UTC), это сдвигает
// календарный день при сравнении с UTC-датами вроде CURRENT_DATE. Отдаём сырой строкой 'YYYY-MM-DD'.
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Неожиданная ошибка на неактивном клиенте PostgreSQL', err);
});

module.exports = { pool };
