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

// Промт 3.6. Диагностика «запрос к данным заведения без фильтра по заведению». Включается
// переменной QUERY_AUDIT=1 и только вне production — см. queryAudit.js: это подсказка
// разработчику, а не защита рантайма, и ложные срабатывания там ожидаемы.
// require здесь, а не сверху: queryAudit читает config/env, который в свою очередь ничего
// не знает про пул, — так цикл зависимостей не возникает.
// eslint-disable-next-line global-require
require('./queryAudit').install(pool);

