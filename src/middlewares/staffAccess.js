// Промт 3.5. Ограничение прав роли staff — ЯВНЫМ БЕЛЫМ СПИСКОМ маршрутов, а не запретами.
//
// Почему белый список: любой новый маршрут админки по умолчанию оказывается для staff закрыт.
// При списке запретов всё наоборот — забыл дописать строку, и официант получил доступ к ценам
// или подписке. Ошибка в белом списке даёт «не пускает туда, куда надо» (заметно сразу), ошибка
// в чёрном — «пускает туда, куда не надо» (не заметно никогда).
//
// Middleware вешается один раз на весь /admin ДО маунтов маршрутов и ПОСЛЕ resolveActiveVenue
// (см. src/app.js): роль в активном заведении выставляет именно он. Для всех, кроме staff,
// это проверка одного поля и next() — на горячем пути админки не должно быть ничего тяжелее.

// Пути — уже без префикса /admin: app.use('/admin', staffAccess) срезает его из req.url,
// и req.path внутри выглядит как '/stoplist'. methodOverride стоит выше по цепочке, поэтому
// req.method здесь уже итоговый (PATCH/DELETE из ?_method=, а не исходный POST).
const STAFF_ALLOWED = [
  // Вход и выход должны работать всегда, иначе staff не сможет даже уйти из системы.
  { methods: ['GET'], path: /^\/login\/?$/ },
  { methods: ['POST'], path: /^\/login\/?$/ },
  { methods: ['POST'], path: /^\/logout\/?$/ },
  { methods: ['GET'], path: /^\/lang\/?$/ },

  // Своя учётка: смена собственного пароля (в том числе принудительная после приглашения).
  { methods: ['GET', 'POST'], path: /^\/password\/?$/ },

  // Промт 3.6: официант может работать в двух точках сети — переключение заведения ему нужно.
  // Право на конкретное заведение проверяется в самом маршруте запросом к admin_venues.
  { methods: ['POST'], path: /^\/switch-venue\/?$/ },

  // Стоп-лист — единственный рабочий экран роли.
  { methods: ['GET'], path: /^\/stoplist\/?$/ },
  { methods: ['GET'], path: /^\/stoplist\/state\/?$/ },
  { methods: ['POST'], path: /^\/stoplist\/items\/\d+\/toggle\/?$/ },
  { methods: ['POST'], path: /^\/stoplist\/options\/\d+\/toggle\/?$/ },
  { methods: ['POST'], path: /^\/stoplist\/restore-all\/?$/ },

  // Вызовы официанта — только если у заведения включены заказы; это проверяет сам маршрут,
  // здесь решается лишь «маршрут в принципе доступен роли».
  { methods: ['GET'], path: /^\/calls\/?$/ },
  { methods: ['GET'], path: /^\/calls\/state\/?$/ },
  { methods: ['POST'], path: /^\/calls\/\d+\/ack\/?$/ },
];

function isAllowedForStaff(method, path) {
  return STAFF_ALLOWED.some((rule) => rule.methods.includes(method) && rule.path.test(path));
}

function staffAccess(req, res, next) {
  const admin = req.session && req.session.admin;
  // Промт 3.6: ограничение навешивается по роли В АКТИВНОМ ЗАВЕДЕНИИ, а не по типу аккаунта.
  // Один и тот же человек может быть manager в одной точке сети и staff в другой — и в другой
  // он обязан видеть только стоп-лист, независимо от того, что написано в admins.role.
  if (!admin || admin.venueRole !== 'staff') return next();

  if (isAllowedForStaff(req.method, req.path)) return next();

  // Корень админки — не 403, а редирект на рабочий экран: официант попадает сюда по привычке
  // и по ссылке из старых закладок, и упираться в отказ на собственной стартовой странице
  // ему незачем.
  if (req.method === 'GET' && /^\/?$/.test(req.path)) {
    return res.redirect('/admin/stoplist');
  }

  return res.status(403).render('errors/403');
}

module.exports = { staffAccess, isAllowedForStaff, STAFF_ALLOWED };
