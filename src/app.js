require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const methodOverride = require('method-override');
const cookieParser = require('cookie-parser');
const { pool } = require('./config/db');
const sessionMiddleware = require('./config/session');
const defaultLocale = require('./middlewares/locale');
const { adminLocale } = require('./middlewares/adminLocale');
const { csrfProtection } = require('./middlewares/csrf');
const adminAuthRoutes = require('./routes/adminAuth');
const adminLocaleRoutes = require('./routes/adminLocale');
const adminDashboardRoutes = require('./routes/adminDashboard');
const superadminRoutes = require('./routes/superadmin');
const adminCategoriesRoutes = require('./routes/adminCategories');
const adminItemsRoutes = require('./routes/adminItems');
const adminVenueSettingsRoutes = require('./routes/adminVenueSettings');
const publicMenuRoutes = require('./routes/publicMenu');
const landingRoutes = require('./routes/landing');
const seoRoutes = require('./routes/seo');
const { toSafeJsonLd } = require('./utils/safeJsonLd');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Доступен во всех EJS-шаблонах как toSafeJsonLd(...) — см. src/utils/safeJsonLd.js.
app.locals.toSafeJsonLd = toSafeJsonLd;
// За обратным прокси (nginx/certbot) req.protocol иначе всегда будет 'http' — это ломает
// canonical/OG/sitemap URL в проде, где реальный трафик идёт по https.
app.set('trust proxy', 1);

// CSP оставляет script-src(-attr)/style-src с 'unsafe-inline' — вся вёрстка построена на
// инлайновых <script> и onclick/onsubmit/onchange-атрибутах (модалки, попапы, корзина и т.п.),
// перевод всего этого на nonce/внешние файлы — отдельная большая переработка, не часть этого
// прохода. Даже так CSP даёт реальную защиту: блокирует подгрузку скриптов/стилей/фреймов С
// ЧУЖИХ ОРИГИНОВ (то, чем обычно пользуется XSS-пейлоад после инъекции — например, добавление
// <script src="https://evil.com/x.js">), запрещает встраивание сайта в чужой iframe
// (clickjacking) и отправку форм на чужой домен.
// useDefaults:false — иначе helmet молча подмешивает свои дефолты к тому, что не переопределено
// явно; так уже словили сюрприз с script-src-attr:'none' (гасит все onclick/onsubmit несмотря
// на 'unsafe-inline' в script-src — это отдельная, более узкая CSP-директива). Проще держать
// весь список директив явным и видимым здесь, чем полагаться на то, что где-то в дефолтах
// helmet ничего не сломает.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // https: (не только 'self') — фото позиций обычно свои (/uploads/... через photoService,
      // передизайн в webp), но у части демо/сид-данных они — внешние ссылки на сток-фото не
      // через форму загрузки. img-src не тот канал, которым в основном пользуются для эксфильтрации
      // после XSS (в отличие от script-src/connect-src), так что ослаблять его до https: — разумный
      // компромисс, а не дыра.
      imgSrc: ["'self'", 'data:', 'https:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));
app.use(sessionMiddleware);
app.use(defaultLocale);

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    console.error('Health check: ошибка подключения к БД', err);
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.use('/admin', adminLocale, csrfProtection, adminAuthRoutes);
app.use('/admin', adminLocale, csrfProtection, adminLocaleRoutes);
app.use('/admin', adminLocale, csrfProtection, adminDashboardRoutes);
app.use('/admin/categories', adminLocale, csrfProtection, adminCategoriesRoutes);
app.use('/admin/items', adminLocale, csrfProtection, adminItemsRoutes);
app.use('/admin/venue-settings', adminLocale, csrfProtection, adminVenueSettingsRoutes);
app.use('/superadmin', adminLocale, csrfProtection, superadminRoutes);
app.use('/menu', publicMenuRoutes);
app.use('/', seoRoutes);
app.use('/', landingRoutes);

app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('errors/500');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

module.exports = app;
