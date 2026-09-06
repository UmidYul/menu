require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const methodOverride = require('method-override');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const { pool } = require('./config/db');
const pgNotify = require('./services/pgNotify');
const sessionMiddleware = require('./config/session');
const defaultLocale = require('./middlewares/locale');
const { adminLocale } = require('./middlewares/adminLocale');
const { csrfProtection } = require('./middlewares/csrf');
const { redirectIfMustChangePassword } = require('./middlewares/auth');
const { leadsBadge } = require('./middlewares/leadsBadge');
const { uploadItemPhoto, uploadVenueImages, uploadReceiptPhoto } = require('./middlewares/upload');
const adminAuthRoutes = require('./routes/adminAuth');
const adminPasswordRoutes = require('./routes/adminPassword');
const adminLocaleRoutes = require('./routes/adminLocale');
const adminDashboardRoutes = require('./routes/adminDashboard');
const superadminRoutes = require('./routes/superadmin');
const superadminLeadsRoutes = require('./routes/superadminLeads');
const superadminPaymentClaimsRoutes = require('./routes/superadminPaymentClaims');
const adminCategoriesRoutes = require('./routes/adminCategories');
const adminItemsRoutes = require('./routes/adminItems');
const adminVenueSettingsRoutes = require('./routes/adminVenueSettings');
const adminSubscriptionRoutes = require('./routes/adminSubscription');
const publicMenuRoutes = require('./routes/publicMenu');
const landingRoutes = require('./routes/landing');
const applyRoutes = require('./routes/apply');
const seoRoutes = require('./routes/seo');
const { toSafeJsonLd } = require('./utils/safeJsonLd');
const { pickLocalized } = require('./utils/localize');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Доступен во всех EJS-шаблонах как toSafeJsonLd(...) — см. src/utils/safeJsonLd.js.
app.locals.toSafeJsonLd = toSafeJsonLd;
// Доступен во всех EJS-шаблонах как pickLocalized(row, field, lang) — см. src/utils/localize.js.
app.locals.pickLocalized = pickLocalized;
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

// /admin/items и /admin/venue-settings ОБЯЗАНЫ быть смонтированы раньше более общих
// app.use('/admin', ...) ниже. Express прогоняет middleware по префиксу пути в порядке
// регистрации независимо от того, найдётся ли внутри роута совпадение — если бы общие
// '/admin'-маунты (auth/locale/dashboard) шли первыми, их csrfProtection перехватывал бы
// ЛЮБОЙ запрос к /admin/items и /admin/venue-settings ещё до того, как multer ниже успел бы
// разобрать multipart-тело, и CSRF-проверка всегда видела бы пустой req.body.
//
// uploadItemPhoto/uploadVenueImages здесь же идут ДО csrfProtection по той же причине: тело
// multipart/form-data парсит только multer (express.urlencoded/json его не трогают), а
// csrfProtection читает req.body._csrf — если он окажется первым, req.body ещё пуст и любая
// форма с файлом (создание/правка позиции, настройки заведения) всегда получит 403. На
// не-multipart запросах (GET, DELETE, /toggle) multer видит несовпадающий Content-Type
// и молча пропускает дальше.
// redirectIfMustChangePassword (промт 1.5) — стоит на каждом маунте с настоящим содержимым
// админки, кроме /admin/password (это и есть форма смены, которую он должен пропускать) и
// общих /admin-маунтов auth/locale ниже (логаут обязан работать всегда, переключение языка
// безобидно). Сам redirect случается только если в сессии реально стоит флаг — на всех
// остальных запросах middleware мгновенно передаёт управление дальше.
app.use('/admin/items', adminLocale, uploadItemPhoto, csrfProtection, redirectIfMustChangePassword, adminItemsRoutes);
app.use('/admin/venue-settings', adminLocale, uploadVenueImages, csrfProtection, redirectIfMustChangePassword, adminVenueSettingsRoutes);
// uploadReceiptPhoto здесь же ДО csrfProtection — POST /admin/subscription/claim несёт
// необязательный скриншот чека (multipart/form-data), та же причина, что у items/venue-settings
// выше. GET / и POST /cancel-claim (обычный urlencoded) multer пропускает молча.
app.use('/admin/subscription', adminLocale, uploadReceiptPhoto, csrfProtection, redirectIfMustChangePassword, adminSubscriptionRoutes);
// /admin/password — сама форма смены пароля и привязка Telegram; сюда redirectIfMustChangePassword
// намеренно не ставится (это и есть единственный маршрут, доступный с флагом must_change_password).
app.use('/admin/password', adminLocale, csrfProtection, adminPasswordRoutes);
app.use('/admin', adminLocale, csrfProtection, adminAuthRoutes);
app.use('/admin', adminLocale, csrfProtection, adminLocaleRoutes);
app.use('/admin', adminLocale, csrfProtection, redirectIfMustChangePassword, adminDashboardRoutes);
app.use('/admin/categories', adminLocale, csrfProtection, redirectIfMustChangePassword, adminCategoriesRoutes);
// /superadmin/leads должен идти раньше общего '/superadmin' ниже — та же причина, что и у
// /admin/items и /admin/venue-settings выше (см. комментарий над ними): более специфичный
// префикс обязан быть зарегистрирован первым, иначе не имеет значения, что superadmin.js
// не содержит маршрутов /leads — порядок регистрации решает, какая цепочка обработает запрос.
app.use('/superadmin/leads', adminLocale, csrfProtection, leadsBadge, superadminLeadsRoutes);
app.use('/superadmin/payment-claims', adminLocale, csrfProtection, leadsBadge, superadminPaymentClaimsRoutes);
app.use('/superadmin', adminLocale, csrfProtection, leadsBadge, superadminRoutes);
app.use('/menu', publicMenuRoutes);
app.use('/apply', csrfProtection, applyRoutes);
app.use('/', seoRoutes);
app.use('/', landingRoutes);

app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('errors/500');
});

const PORT = env.PORT;

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

// Отдельное LISTEN-соединение для инвалидации кэша меню между процессами (веб + бот) —
// см. src/services/pgNotify.js. Не блокирует старт сервера и не роняет процесс, если
// в этот момент БД недоступна.
pgNotify.start();

module.exports = app;
