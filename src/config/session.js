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
  cookie: {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});

module.exports = sessionMiddleware;
