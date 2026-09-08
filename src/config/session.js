const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');
const env = require('./env');

const sessionMiddleware = session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  name: 'qrmenu.sid',
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // Промт 4.2: rolling-обновление при активности. Без него сессия истекает ровно через неделю
  // после ВХОДА, даже если человек работал в кабинете каждый день, — и его выкидывает посреди
  // работы. С rolling срок продлевается на каждый запрос, а неактивная сессия всё так же
  // умирает через maxAge.
  // resave остаётся false: connect-pg-simple сам продлевает строку в user_sessions, когда
  // rolling меняет cookie, — переписывать сессию на КАЖДЫЙ запрос ради этого не нужно.
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});

module.exports = sessionMiddleware;
