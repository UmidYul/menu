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
const { reviewsBadge } = require('./middlewares/reviewsBadge');
const { staffAccess } = require('./middlewares/staffAccess');
const { resolveActiveVenue } = require('./middlewares/activeVenue');
const { customDomain } = require('./middlewares/customDomain');
const errorAlerts = require('./services/errorAlerts');
const logger = require('./services/logger');
const { uploadItemPhoto, uploadVenueImages, uploadReceiptPhoto } = require('./middlewares/upload');
const adminAuthRoutes = require('./routes/adminAuth');
const adminPasswordRoutes = require('./routes/adminPassword');
const adminLocaleRoutes = require('./routes/adminLocale');
const adminDashboardRoutes = require('./routes/adminDashboard');
const superadminRoutes = require('./routes/superadmin');
const superadminLeadsRoutes = require('./routes/superadminLeads');
const superadminPaymentClaimsRoutes = require('./routes/superadminPaymentClaims');
const adminCategoriesRoutes = require('./routes/adminCategories');
const adminAnalyticsRoutes = require('./routes/adminAnalytics');
const adminTablesRoutes = require('./routes/adminTables');
const adminOrdersSettingsRoutes = require('./routes/adminOrdersSettings');
const adminPrintRoutes = require('./routes/adminPrint');
const adminReviewsRoutes = require('./routes/adminReviews');
const adminSchedulesRoutes = require('./routes/adminSchedules');
const adminStoplistRoutes = require('./routes/adminStoplist');
const adminCallsRoutes = require('./routes/adminCalls');
const adminStaffRoutes = require('./routes/adminStaff');
const adminVenueSwitchRoutes = require('./routes/adminVenueSwitch');
const adminVenuesRoutes = require('./routes/adminVenues');
const adminDomainsRoutes = require('./routes/adminDomains');
const adminItemsRoutes = require('./routes/adminItems');
const adminItemOptionsRoutes = require('./routes/adminItemOptions');
const adminVenueSettingsRoutes = require('./routes/adminVenueSettings');
const adminSubscriptionRoutes = require('./routes/adminSubscription');
const apiEventsRoutes = require('./routes/apiEvents');
const publicOrdersRoutes = require('./routes/publicOrders');
const publicReviewsRoutes = require('./routes/publicReviews');
const publicMenuRoutes = require('./routes/publicMenu');
const publicPwaRoutes = require('./routes/publicPwa');
const healthRoutes = require('./routes/health');
const landingRoutes = require('./routes/landing');
const applyRoutes = require('./routes/apply');
const seoRoutes = require('./routes/seo');
const { eventsByIpLimiter, eventsBySessionLimiter, ordersByIpLimiter, reviewsByIpLimiter } = require('./middlewares/rateLimit');
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

// Промт 4.2, ревизия безопасности. script-src и script-src-attr затянуты до 'self':
// инлайновых обработчиков (onclick/onchange/onsubmit) и инлайновых <script> в шаблонах
// не осталось — все они переехали в файлы под src/public/js (см. modal.js, share-button.js,
// subscription-price.js). Именно эти две директивы и защищают от XSS-пейлоада: чужой
// <script src="https://evil/x.js"> и инъекция в onclick теперь блокируются браузером.
//
// style-src сознательно оставлен с 'unsafe-inline'. В шаблонах ~190 атрибутов style= —
// это вёрстка (margin-top, grid-template-columns), а не вектор атаки после того, как заперт
// script-src: без исполнения скриптов CSS-инъекция даёт максимум порчу оформления. Их вычистка
// — переработка дизайн-системы, а не мера безопасности, и называть CSP «строгой» до неё
// было бы неправдой. Это осознанный остаток, а не забытый пункт.
//
// useDefaults:false — иначе helmet молча подмешивает свои дефолты к тому, что не переопределено
// явно; так уже словили сюрприз с script-src-attr:'none'. Проще держать весь список директив
// явным и видимым здесь.
//
// frameAncestors здесь НЕ задаётся: он разный для публичного меню и для кабинета,
// его ставит middleware frameGuard ниже.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
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
      upgradeInsecureRequests: [],
    },
  },
  // X-Frame-Options ставится тем же middleware, что и frame-ancestors, — иначе helmet
  // проставил бы глобальный DENY и перекрыл бы разрешение на встраивание меню.
  frameguard: false,
}));

// Промт 4.2: «публичное меню можно разрешить встраивать, админку — нет». Заведение может
// захотеть показать своё меню на собственном сайте — это законный сценарий. Всё остальное
// (кабинет, суперадминка, формы) встраивать нельзя: там есть действия, которые кликджекингом
// можно выполнить чужими руками.
// Риск на самом меню осознан: там есть кнопка отправки заказа, и в теории её можно подложить
// под чужой интерфейс. Цена такого «заказа» — один звонок официанта в зал, а не потеря денег
// или доступа, поэтому разрешение считаю оправданным.
function frameGuard(req, res, next) {
  const embeddable = req.path.startsWith('/menu/') || req.path.startsWith('/uploads/');
  // Для встраиваемых путей НИЧЕГО не делаем. Первая версия ставила здесь setHeader
  // с 'frame-ancestors *' — и затирала всю политику, выставленную helmet выше: у публичного
  // меню оставался единственный frame-ancestors и ни script-src, ни default-src. Отсутствие
  // frame-ancestors и так означает «встраивать можно», а frameguard:false у helmet уже
  // выключил X-Frame-Options, так что делать тут нечего.
  if (embeddable) return next();

  res.setHeader('X-Frame-Options', 'DENY');
  // Именно append: setHeader заменил бы политику helmet целиком. Два заголовка CSP браузер
  // применяет пересечением — то есть строже, а не свободнее.
  res.append('Content-Security-Policy', "frame-ancestors 'none'");
  return next();
}
app.use(frameGuard);

// Промт 4.2: каталог uploads отдаётся без выполнения скриптов. express.static ничего не
// исполняет сам, но залитый .svg или .html — это активный контент НА НАШЕМ ЖЕ origin:
// открыв такую ссылку, гость выполнит чужой скрипт с нашими cookie. Своя CSP на этот путь
// запрещает там вообще всё, а nosniff не даёт браузеру угадать тип в обход Content-Type.
function uploadsGuard(req, res, next) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(cookieParser());

// Промт 3.7. Маршрутизация по хосту — ДО статики, сессии и всех маршрутов: решение
// «это кастомный домен» меняет всё, что идёт дальше, и принимать его посреди цепочки нельзя.
// До статики — потому что на кастомном домене доступен не любой файл, а только то, что нужно
// самому меню (белый список в middlewares/customDomain.js).
app.use(customDomain);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', uploadsGuard, express.static(path.join(__dirname, '..', 'public', 'uploads')));

// Промт 3.7: «Cookie сессии не должны выставляться на кастомных доменах».
//
// Сессия там не нужна вообще: доступно только публичное меню, а гость анонимен. Но дело не
// только в ненужности — express-session на кастомном домене поставил бы qrmenu.sid на ДОМЕН
// ЗАВЕДЕНИЯ, то есть раздал бы идентификаторы сессий сервиса по чужим зонам. Один общий secret,
// сотня доменов и cookie, которую заведение видит у себя, — это ровно то, чего делать нельзя.
//
// req.session остаётся undefined; публичный путь к этому готов (см. isOwnerPreview
// в routes/publicMenu.js), а всё, что сессию действительно требует, на кастомный домен
// не попадает — оно отсеяно редиректом выше.
app.use((req, res, next) => {
  if (req.customDomain) return next();
  return sessionMiddleware(req, res, next);
});

app.use(defaultLocale);

// Промт 4.2: подробный отчёт — отдельным роутером, доступ с localhost или по HEALTH_TOKEN.
// Смонтирован ДО простого /health ниже: тот отвечает на точное совпадение пути и /health/detailed
// не перехватывает, но порядок всё равно держим явным.
app.use('/health', healthRoutes);

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
// Промт 3.6. Активное заведение резолвится ПЕРВЫМ среди /admin-middleware: от него зависят
// и права роли (staffAccess ниже смотрит на роль в активном заведении), и бейдж отзывов,
// и всё, что читает req.session.admin.venueId. Доступ перепроверяется в БД на каждый запрос —
// это единственная гарантия, что отозванный доступ перестаёт действовать сразу, а не через
// неделю, когда истечёт сессия.
app.use('/admin', resolveActiveVenue);
// Промт 3.5. Права роли staff — явным белым списком маршрутов, один раз на весь /admin/* и
// строго ДО маунтов: любой маршрут, не перечисленный в middlewares/staffAccess.js, для официанта
// закрыт по умолчанию, включая те, которых ещё не существует. Для остальных ролей это проверка
// одного поля сессии.
app.use('/admin', staffAccess);
// Бейдж непрочитанных отзывов (промт 3.3) — один раз на весь /admin/*, до маршрутов: сайдбар
// одинаковый на всех страницах админки заведения, и число в нём не должно зависеть от того,
// какой именно раздел открыт (та же логика, что у leadsBadge в суперадминке ниже).
app.use('/admin', reviewsBadge);
app.use('/admin/items', adminLocale, uploadItemPhoto, csrfProtection, redirectIfMustChangePassword, adminItemsRoutes);
// Группы опций позиции (промт 2.1) — отдельный префикс, без multer: файлов здесь не бывает,
// формы обычные urlencoded плюс один JSON-эндпоинт перетаскивания.
app.use('/admin/item-options', adminLocale, csrfProtection, redirectIfMustChangePassword, adminItemOptionsRoutes);
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
app.use('/admin/analytics', adminLocale, csrfProtection, redirectIfMustChangePassword, adminAnalyticsRoutes);
app.use('/admin/tables', adminLocale, csrfProtection, redirectIfMustChangePassword, adminTablesRoutes);
app.use('/admin/orders-settings', adminLocale, csrfProtection, redirectIfMustChangePassword, adminOrdersSettingsRoutes);
app.use('/admin/print', adminLocale, csrfProtection, redirectIfMustChangePassword, adminPrintRoutes);
app.use('/admin/reviews', adminLocale, csrfProtection, redirectIfMustChangePassword, adminReviewsRoutes);
// Расписания доступности (промт 2.3) — как /admin/item-options: отдельный префикс, потому что
// формы расписания не могут быть вложены в форму категории/позиции, внутри которой они живут.
app.use('/admin/schedules', adminLocale, csrfProtection, redirectIfMustChangePassword, adminSchedulesRoutes);
// Промт 3.5. Рабочие экраны официанта и управление сотрудниками.
app.use('/admin/stoplist', adminLocale, csrfProtection, redirectIfMustChangePassword, adminStoplistRoutes);
app.use('/admin/calls', adminLocale, csrfProtection, redirectIfMustChangePassword, adminCallsRoutes);
app.use('/admin/staff', adminLocale, csrfProtection, redirectIfMustChangePassword, adminStaffRoutes);
// Промт 3.6. Переключение активного заведения — без redirectIfMustChangePassword: смена
// заведения не даёт доступа к данным сама по себе, а флаг «смени пароль» и так перехватит
// любой следующий переход.
app.use('/admin/switch-venue', adminLocale, csrfProtection, adminVenueSwitchRoutes);
// Промт 3.6, разделы 4 и 5: сводный экран сети и копирование меню между заведениями.
app.use('/admin/venues', adminLocale, csrfProtection, redirectIfMustChangePassword, adminVenuesRoutes);
// Промт 3.7. Свой домен заведения — отдельным префиксом, а не внутри venue-settings:
// формы подключения/отключения домена не могут быть вложены в форму настроек.
app.use('/admin/domain', adminLocale, csrfProtection, redirectIfMustChangePassword, adminDomainsRoutes);
// /superadmin/leads должен идти раньше общего '/superadmin' ниже — та же причина, что и у
// /admin/items и /admin/venue-settings выше (см. комментарий над ними): более специфичный
// префикс обязан быть зарегистрирован первым, иначе не имеет значения, что superadmin.js
// не содержит маршрутов /leads — порядок регистрации решает, какая цепочка обработает запрос.
app.use('/superadmin/leads', adminLocale, csrfProtection, leadsBadge, superadminLeadsRoutes);
app.use('/superadmin/payment-claims', adminLocale, csrfProtection, leadsBadge, superadminPaymentClaimsRoutes);
app.use('/superadmin', adminLocale, csrfProtection, leadsBadge, superadminRoutes);
// Промт 3.2. Без csrfProtection (как /menu ниже — гость анонимен) и без adminLocale/locale
// вообще: это не HTML-страница, ответ всегда 204 без тела. Свои лимитеры — IP затем session_hash
// (см. комментарии в middlewares/rateLimit.js).
app.use('/api/events', eventsByIpLimiter, eventsBySessionLimiter, apiEventsRoutes);
// Промт 2.4. Как и /api/events — публичный, анонимный, без csrfProtection: у гостя нет сессии,
// к которой можно привязать токен. Защита — лимитеры (IP здесь, session_hash внутри роута),
// серверный пересчёт суммы и httpOnly-cookie стола, которую клиент не может подделать.
app.use('/order', ordersByIpLimiter, publicOrdersRoutes);
// Отзывы (промт 3.3) — публичный анонимный маршрут, как /order и /api/events: без csrfProtection
// (сессии у гостя нет), защита — лимитер по IP тут и правило «один отзыв в 30 дней» в БД.
app.use('/review', reviewsByIpLimiter, publicReviewsRoutes);
// Промт 2.5. Манифест PWA монтируется на /menu РАНЬШЕ publicMenuRoutes: там есть маршрут
// '/:slug/:categoryId', который иначе принял бы 'manifest.webmanifest' за id категории.
app.use('/menu', publicPwaRoutes);
app.use('/menu', publicMenuRoutes);
app.use('/apply', csrfProtection, applyRoutes);
app.use('/', seoRoutes);
app.use('/', landingRoutes);

app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

// Промт 4.2, раздел 3. Централизованный обработчик дополнен алертом владельцу сервиса
// и структурированной записью в файл. Сам алерт дедуплицируется по стеку (см. errorAlerts.js):
// без этого одна массовая ошибка превратится в тысячу сообщений и бота заблокируют.
// Гостю и администратору наружу по-прежнему уходит только страница 500 — ни стека, ни текста
// ошибки: errors/500 их не выводит, а NODE_ENV=production у Express дополнительно гасит
// собственную страницу ошибки с трассировкой.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  errorAlerts.reportServerError(err, req).catch((alertErr) => {
    logger.error('error_alert_failed', { message: alertErr.message });
  });
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
