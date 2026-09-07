// Промт 2.4: «Заказ невозможен вне часов работы заведения — проверять на сервере».
//
// venues.working_hours — свободный текст, который владелец набирает руками («Пн-Вс: 08:00–02:00»).
// Ровно та же наивная эвристика уже работает на клиенте и рисует бейдж «открыто сейчас»
// (src/public/js/public-menu.js): берём ПЕРВЫЙ найденный интервал ЧЧ:ММ–ЧЧ:ММ и считаем, что он
// действует каждый день. Здесь она вынесена как есть, чтобы сервер и бейдж не расходились: гость,
// видящий «открыто сейчас», обязан иметь возможность отправить заказ, иначе это выглядит поломкой.
//
// Известное ограничение (унаследованное, не новое): разные часы по дням недели («Пн-Пт 09-18,
// Сб-Вс 10-16») не разбираются — учитывается только первый интервал. Заведению с таким графиком
// проверка будет мягче, чем следовало бы. Строгий разбор потребовал бы структурированного
// расписания вместо свободного текста — это отдельная задача, не часть промта 2.4.
const RANGE_RE = /(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/;

function parseRange(workingHours) {
  const match = String(workingHours || '').match(RANGE_RE);
  if (!match) return null;
  const startMinutes = Number(match[1]) * 60 + Number(match[2]);
  const endMinutes = Number(match[3]) * 60 + Number(match[4]);
  if (startMinutes === endMinutes) return null;
  return { startMinutes, endMinutes };
}

// nowMinutes — минуты от полуночи ПО МЕСТНОМУ ВРЕМЕНИ ЗАВЕДЕНИЯ. Отдельного часового пояса у
// заведений в схеме нет, поэтому используется время сервера — то же допущение, что и у бейджа
// на клиенте (там берётся время устройства гостя).
function isOpenAt(workingHours, nowMinutes) {
  const range = parseRange(workingHours);
  // Часы не заполнены или не распарсились — не запрещаем заказ: лучше принять заказ у закрытого
  // заведения (персонал увидит и разберётся), чем молча блокировать работающее.
  if (!range) return true;

  const { startMinutes, endMinutes } = range;
  // Интервал через полночь (08:00–02:00) — «открыто» это до конца суток ИЛИ после полуночи.
  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function isOpenNow(workingHours, now = new Date()) {
  return isOpenAt(workingHours, now.getHours() * 60 + now.getMinutes());
}

module.exports = { isOpenNow, isOpenAt, parseRange };
