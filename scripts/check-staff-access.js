// Промт 3.5. Проверка белого списка прав роли staff:
//   node scripts/check-staff-access.js
//
// Смысл в том, чтобы НЕ доверять ручному обходу страниц. Скрипт поднимает приложение, обходит
// стек роутеров Express и перечисляет ВСЕ маршруты под /admin, какие в нём зарегистрированы,
// а затем показывает, какие из них белый список открывает официанту. Появился новый раздел
// админки — он сразу виден здесь в списке закрытых; попал в открытые по недосмотру —
// это тоже видно, и не после инцидента, а при первом же прогоне.
require('dotenv').config();

// src/app.js при загрузке поднимает HTTP-сервер на PORT. Скрипту сервер не нужен — нужен только
// стек роутеров, — но и занимать порт уже работающего приложения он не должен. Поэтому порт
// подменяется ЗДЕСЬ, до первого require, а не снаружи через окружение: снаружи PORT утекал бы
// и в остальные скрипты (check-idor брал из него APP_BASE_URL и стучался не туда).
process.env.PORT = process.env.STAFF_ACCESS_PORT || '39999';

const { isAllowedForStaff } = require('../src/middlewares/staffAccess');

// Маршруты, которые официанту ОБЯЗАНЫ быть доступны. Если после правок белого списка какой-то
// из них закроется, официант останется без рабочего экрана — это тоже поломка, и о ней надо
// узнать здесь, а не из звонка «у меня всё пропало».
const MUST_BE_OPEN = [
  ['GET', '/stoplist'],
  ['POST', '/stoplist/items/12/toggle'],
  ['POST', '/stoplist/options/12/toggle'],
  ['POST', '/stoplist/restore-all'],
  ['GET', '/stoplist/state'],
  ['GET', '/calls'],
  ['POST', '/calls/12/ack'],
  ['GET', '/password'],
  ['POST', '/password'],
  ['POST', '/logout'],
  ['POST', '/switch-venue'],
];

// Маршруты, которые официанту не должны быть доступны ни при каких обстоятельствах. Список
// намеренно дублирует часть реальных путей руками: это независимая проверка, а не пересказ
// самого белого списка другими словами.
const MUST_BE_CLOSED = [
  ['GET', '/'],
  ['GET', '/items'],
  ['POST', '/items'],
  ['POST', '/items/12/toggle'],
  ['PATCH', '/items/12'],
  ['DELETE', '/items/12'],
  ['GET', '/categories'],
  ['POST', '/categories'],
  ['GET', '/analytics'],
  ['GET', '/analytics/export.xlsx'],
  ['GET', '/reviews'],
  ['POST', '/reviews/toggle'],
  ['POST', '/reviews/settings'],
  ['GET', '/tables'],
  ['POST', '/tables'],
  ['GET', '/print'],
  ['GET', '/venue-settings'],
  ['POST', '/venue-settings'],
  ['GET', '/subscription'],
  ['POST', '/subscription/claim'],
  ['GET', '/orders-settings'],
  ['POST', '/orders-settings/toggle-orders'],
  ['GET', '/staff'],
  ['POST', '/staff'],
  ['POST', '/staff/12/invite'],
  ['POST', '/schedules/item/12'],
  ['POST', '/item-options/groups/12'],
  ['GET', '/qr.png'],
  // Похожие, но не те пути — белый список не должен ловить их «почти совпадением».
  ['GET', '/stoplist/../items'],
  ['POST', '/stoplist/items/12/toggle/../../../../items/12/toggle'],
  ['POST', '/calls/12/ack/extra'],
  ['GET', '/stoplistx'],
];

let failures = 0;

function report(ok, label) {
  if (ok) {
    console.log(`  ok   ${label}`);
    return;
  }
  console.error(`  FAIL ${label}`);
  failures += 1;
}

console.log('Должны быть ОТКРЫТЫ для staff:');
MUST_BE_OPEN.forEach(([method, path]) => {
  report(isAllowedForStaff(method, path) === true, `${method} ${path}`);
});

console.log('\nДолжны быть ЗАКРЫТЫ для staff:');
MUST_BE_CLOSED.forEach(([method, path]) => {
  report(isAllowedForStaff(method, path) === false, `${method} ${path}`);
});

// Обход реального стека роутеров: перечисляем то, что приложение действительно зарегистрировало
// под /admin, и раскладываем на открытое и закрытое. Список печатается целиком — это не тест
// с ожидаемым значением, а то, что нужно прочитать глазами после добавления новых разделов.
console.log('\nФактические маршруты под /admin (из стека Express):');
const app = require('../src/app');

function collect(stack, prefix, out) {
  stack.forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
      out.push({ prefix, path: layer.route.path, methods });
      return;
    }
    if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      // Восстанавливаем префикс маунта из регулярки слоя — иного способа Express не даёт.
      const source = layer.regexp && layer.regexp.source;
      const match = source && /^\^\\\/((?:[\w\-.]|\\\/)+)/.exec(source);
      const mounted = match ? `/${match[1].replace(/\\\//g, '/')}` : '';
      collect(layer.handle.stack, prefix + mounted, out);
    }
  });
}

const routes = [];
collect(app._router.stack, '', routes);

const adminRoutes = routes
  .filter((route) => (route.prefix + route.path).startsWith('/admin'))
  .map((route) => {
    // Схлопываем повторные слэши: маунт '/admin' + путь '/logout' внутри роутера, смонтированного
    // на тот же '/admin', даёт '/admin//logout'. В реальном запросе такого пути не бывает —
    // это артефакт восстановления префикса из регулярки слоя, а не то, что видит middleware.
    const full = (route.prefix + route.path).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    // staffAccess срезает префикс /admin — сверяем ровно тот путь, который увидит middleware.
    const relative = full.replace(/^\/admin/, '') || '/';
    // :id в пути заменяем числом, иначе регулярки белого списка не совпадут.
    const concrete = relative.replace(/:[A-Za-z]+/g, '12');
    return { full, concrete, methods: route.methods };
  })
  .sort((a, b) => a.full.localeCompare(b.full));

const open = [];
const closed = [];
adminRoutes.forEach((route) => {
  route.methods.forEach((method) => {
    const label = `${method} ${route.full}`;
    if (isAllowedForStaff(method, route.concrete)) open.push(label);
    else closed.push(label);
  });
});

console.log(`\n  ОТКРЫТО для staff (${open.length}):`);
open.forEach((label) => console.log(`    ${label}`));
console.log(`\n  ЗАКРЫТО для staff (${closed.length}):`);
closed.forEach((label) => console.log(`    ${label}`));

if (failures > 0) {
  console.error(`\nпровалов: ${failures}`);
  process.exitCode = 1;
} else {
  console.log('\nбелый список ведёт себя как задумано');
}

// app.listen в src/app.js уже поднял порт — гасим процесс, чтобы скрипт не висел.
process.exit(process.exitCode || 0);
