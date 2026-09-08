const env = require('../config/env');
const domainCache = require('../services/domainCache');
const { normalizeDomain, stripWww, withWww } = require('../utils/domainName');

// Промт 3.7, раздел 2. Маршрутизация по хосту.
//
// Стоит В САМОМ НАЧАЛЕ цепочки — до сессии, до локали, до всех маршрутов. Причина не в скорости:
// решение «это кастомный домен» меняет всё, что идёт дальше (сессию не подключаем, админку
// не отдаём, SEO-теги строим на другой адрес), и принимать его после того, как половина
// цепочки уже отработала, значит принимать его дважды.
//
// На кастомном домене доступно ТОЛЬКО публичное меню. Всё остальное — редирект на основной
// домен: это и безопаснее (сессия и CSRF живут ровно на одном хосте), и правильнее для
// поисковиков, которым иначе досталась бы вторая копия лендинга на каждом домене заведения.

// Пути, которые обязаны работать на кастомном домене помимо самого меню.
// /.well-known/acme-challenge — HTTP-01 от Let's Encrypt: nginx проксирует его сюда либо отдаёт
// из общего каталога (см. README), но редиректить его нельзя ни при каком раскладе, иначе
// сертификат не выпустится и не продлится.
const CUSTOM_DOMAIN_ALLOWED = [
  /^\/\.well-known\//,
  /^\/uploads\//,
  /^\/css\//,
  /^\/js\//,
  /^\/fonts\//,
  /^\/icons\//,
  /^\/favicon\.svg$/,
  /^\/offline\.html$/,
  /^\/sw\.js$/,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/health$/,
  // Публичные API самого меню: заказы, вызов официанта, отзывы, события, манифест PWA
  // и og-картинка. Без них меню на своём домене превратилось бы в картинку без кнопок.
  /^\/order\//,
  /^\/review\//,
  /^\/api\/events\//,
  /^\/og\//,
];

function isAllowedOnCustomDomain(pathname) {
  return CUSTOM_DOMAIN_ALLOWED.some((rule) => rule.test(pathname));
}

// Хост запроса без порта и в нижнем регистре. req.hostname у Express уже учитывает
// X-Forwarded-Host при trust proxy, но не нормализует IDN — а Host от браузера всегда приходит
// в punycode, так что normalizeDomain здесь и сводит обе формы к одной.
function requestDomain(req) {
  const raw = req.hostname || '';
  return normalizeDomain(raw) || raw.toLowerCase();
}

// Хост сервиса может быть задан с портом (localhost:3000 в разработке) — сравниваем без него.
function serviceHostname() {
  return (env.SERVICE_HOST || '').split(':')[0].toLowerCase();
}

// Свой ли это хост. www.qr.menu и qr.menu — оба свои: у сервиса собственный редирект между ними
// делает nginx, и уводить www-версию в логику кастомных доменов нельзя.
function isServiceHost(domain) {
  const own = serviceHostname();
  if (!own) return true;
  return domain === own || stripWww(domain) === stripWww(own);
}

function serviceBaseUrl(req) {
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${env.SERVICE_HOST || req.get('host')}`;
}

async function resolveCustomDomain(req, res, next) {
  // Маршрутизация по хосту выключена, если сервис не знает собственного адреса: отличить
  // свой хост от чужого тогда нечем, и любое решение было бы угадыванием.
  if (!env.customDomainsConfigured) return next();

  const domain = requestDomain(req);
  if (!domain || isServiceHost(domain)) return next();

  let found = domainCache.lookup(domain);

  // Снимок ещё не готов — первые миллисекунды после старта процесса, до того как отработал
  // прогрев из pgNotify.start(). Дожидаемся загрузки, а не отвечаем ошибкой: параллельные
  // запросы разделяют один и тот же запрос к БД (см. domainCache.reload), так что ожидание
  // случается ровно один раз за старт. Отдать здесь 503 или редирект на сервис значило бы
  // показать владельцу «мой домен не работает» на ровном месте.
  if (found === undefined) {
    await domainCache.reload();
    found = domainCache.lookup(domain);
    // Загрузка не удалась (БД недоступна) — снимка по-прежнему нет. Пропускаем дальше:
    // маршрут не найдётся и гость получит обычную 404, а не редирект на сервис, который
    // браузер мог бы закэшировать как постоянный.
    if (found === undefined) return next();
  }

  // Промт, edge case: «Кто-то направил свой домен на твой IP без добавления в систему — nginx
  // не должен отдавать чужое меню». Первым рубежом это делает default_server в nginx (см. README),
  // но приложение обязано вести себя так же и в одиночку: на неизвестном хосте — только уход
  // на сервис, никогда не меню какого-либо заведения.
  if (!found) {
    return res.redirect(301, serviceBaseUrl(req));
  }

  // Промт: «Редирект с www на без-www (или наоборот, по настройке) — 301». Настройка — это
  // сам флаг is_primary: у пары доменов один помечен основным, и он же адрес, на который
  // сходятся ссылки, canonical и sitemap. Отдельного переключателя не нужно — он был бы
  // вторым источником правды о том же самом.
  if (!found.isPrimary) {
    const primary = domainCache.lookup(
      domain.startsWith('www.') ? stripWww(domain) : withWww(domain)
    );
    if (primary && primary.isPrimary && primary.venueId === found.venueId) {
      return res.redirect(301, `${req.protocol}://${primary.domain}${req.originalUrl}`);
    }
    // Пары нет (основной домен удалили, алиас остался) — алиас работает сам по себе,
    // иначе гость по уже напечатанному QR упёрся бы в никуда.
  }

  req.customDomain = {
    venueId: found.venueId,
    slug: found.slug,
    domain: found.domain,
    isPrimary: found.isPrimary,
  };

  // Корень кастомного домена — это и есть меню заведения. Подменяем маршрут, а не редиректим:
  // адрес menu.mykafe.uz/ должен таким и оставаться, иначе весь смысл своего домена теряется.
  if (req.url === '/' || req.url.startsWith('/?')) {
    req.url = `/menu/${found.slug}${req.url.slice(1)}`;
    return next();
  }

  // Уже нормальный путь меню этого заведения — пропускаем как есть (сюда попадают ссылки
  // на категорию: /menu/<slug>/<categoryId>).
  if (req.path.startsWith(`/menu/${found.slug}`)) return next();

  if (isAllowedOnCustomDomain(req.path)) return next();

  // Всё остальное — админка, суперадминка, лендинг, чужие меню — на основной домен.
  // Путь НЕ переносим: /admin на кастомном домене ведёт на /admin сервиса, но, например,
  // /menu/чужой-slug вести на чужое меню не должен, а разбирать эти случаи по отдельности —
  // лишний повод ошибиться. Корень сервиса подходит всем.
  return res.redirect(301, serviceBaseUrl(req));
}

// Обёртка, чтобы отказ внутри async-middleware уходил в общий обработчик ошибок, а не
// оставался неперехваченным промисом (Express 4 сам async-функции не разворачивает).
function customDomain(req, res, next) {
  resolveCustomDomain(req, res, next).catch(next);
}

module.exports = {
  customDomain, resolveCustomDomain, isAllowedOnCustomDomain, isServiceHost, requestDomain, serviceBaseUrl,
};
