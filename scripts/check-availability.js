// Проверка расчёта расписаний (промт 2.3). Не юнит-тест в привычном смысле — в проекте нет
// тестового раннера, — а самопроверка ключевых случаев, которую можно прогнать руками:
//   node scripts/check-availability.js
// Сюда вынесены ровно те случаи, которые промт называет обязательными: переход через полночь,
// круглосуточный интервал без разрывов, часовой пояс заведения, ближайшая граница для кэша.
const assert = require('assert');
const availability = require('../src/services/availability');

const { venueNow, ruleMatches, isAvailableNow, secondsUntilChange, nextOpeningSeconds } = availability;

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

// Момент «в поясе заведения» строим руками, минуя Intl: проверяем саму арифметику интервалов.
function at(weekday, time) {
  return { timezone: 'Asia/Tashkent', weekday, seconds: availability.timeToSeconds(time) };
}

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
function rule(days, from, to, extra) {
  return Object.assign({ days, time_from: from, time_to: to, is_active: true }, extra || {});
}

console.log('Обычный интервал 08:00–11:00, Пн–Пт');
{
  const r = rule([1, 2, 3, 4, 5], '08:00:00', '11:00:00');
  check('в 08:00 доступно (граница начала включительно)', () => assert.strictEqual(ruleMatches(r, at(1, '08:00')), true));
  check('в 10:59:59 доступно', () => assert.strictEqual(ruleMatches(r, at(1, '10:59:59')), true));
  check('в 11:00 уже нет (граница конца исключительно)', () => assert.strictEqual(ruleMatches(r, at(1, '11:00')), false));
  check('в 07:59:59 ещё нет', () => assert.strictEqual(ruleMatches(r, at(1, '07:59:59')), false));
  check('в субботу не доступно', () => assert.strictEqual(ruleMatches(r, at(6, '09:00')), false));
}

console.log('Интервал через полночь 22:00–02:00, только пятница');
{
  const r = rule([5], '22:00:00', '02:00:00');
  check('пятница 22:00 — доступно', () => assert.strictEqual(ruleMatches(r, at(5, '22:00')), true));
  check('пятница 23:59 — доступно', () => assert.strictEqual(ruleMatches(r, at(5, '23:59')), true));
  check('суббота 00:30 — доступно (хвост пятничного интервала)', () => assert.strictEqual(ruleMatches(r, at(6, '00:30')), true));
  check('суббота 01:59:59 — доступно', () => assert.strictEqual(ruleMatches(r, at(6, '01:59:59')), true));
  check('суббота 02:00 — уже нет', () => assert.strictEqual(ruleMatches(r, at(6, '02:00')), false));
  check('суббота 22:00 — нет (суббота не в днях)', () => assert.strictEqual(ruleMatches(r, at(6, '22:00')), false));
  check('пятница 01:00 — нет (это хвост ЧЕТВЕРГА, а он не в днях)', () => assert.strictEqual(ruleMatches(r, at(5, '01:00')), false));
}

console.log('Переход через полночь на стыке недели (воскресенье → понедельник)');
{
  const r = rule([7], '23:00:00', '01:00:00');
  check('воскресенье 23:30 — доступно', () => assert.strictEqual(ruleMatches(r, at(7, '23:30')), true));
  check('понедельник 00:30 — доступно', () => assert.strictEqual(ruleMatches(r, at(1, '00:30')), true));
  check('понедельник 01:30 — нет', () => assert.strictEqual(ruleMatches(r, at(1, '01:30')), false));
}

console.log('Круглосуточно: 00:00–23:59 нормализуется и не даёт разрывов');
{
  const normalized = availability.normalizeInterval(
    availability.timeToSeconds('00:00'),
    availability.timeToSeconds('23:59')
  );
  check('00:00–23:59 → 00:00–00:00', () => assert.deepStrictEqual(normalized, { from: 0, to: 0 }));

  const r = rule(ALL_DAYS, '00:00:00', '00:00:00');
  ['00:00', '11:00', '23:59', '23:59:59'].forEach((time) => {
    check(`круглосуточно доступно в ${time}`, () => assert.strictEqual(ruleMatches(r, at(3, time)), true));
  });

  // Тот же приём для интервала, начинающегося не с полуночи: 18:00–17:59 это тоже сутки.
  const evening = availability.normalizeInterval(
    availability.timeToSeconds('18:00'),
    availability.timeToSeconds('17:59')
  );
  check('18:00–17:59 → тоже ровно сутки', () => assert.deepStrictEqual(evening, { from: 64800, to: 64800 }));
}

console.log('Несколько интервалов на одну сущность');
{
  const rules = [rule([1, 2, 3, 4, 5], '08:00:00', '11:00:00'), rule([6, 7], '09:00:00', '13:00:00')];
  check('будни 09:00 — доступно', () => assert.strictEqual(isAvailableNow(rules, at(2, '09:00')), true));
  check('суббота 12:00 — доступно (второй интервал)', () => assert.strictEqual(isAvailableNow(rules, at(6, '12:00')), true));
  check('суббота 08:00 — нет', () => assert.strictEqual(isAvailableNow(rules, at(6, '08:00')), false));
  check('пустой набор правил — доступно всегда', () => assert.strictEqual(isAvailableNow([], at(6, '03:00')), true));
  // Выключенный интервал = отсутствующий, а не запрещающий: галочкой рядом с одним интервалом
  // владелец не должен уметь погасить позицию навсегда. Про эту неочевидность предупреждает
  // админка (scheduleWarnings ниже), а не молча меняется поведение гостя.
  check('все правила выключены — ведёт себя как «расписания нет»', () => assert.strictEqual(
    isAvailableNow([rule([1], '08:00:00', '11:00:00', { is_active: false })], at(1, '09:00')),
    true
  ));
}

console.log('Ближайшая граница — срок жизни кэша');
{
  const r = rule(ALL_DAYS, '08:00:00', '11:00:00');
  check('в 10:30 до конца интервала 30 минут', () => assert.strictEqual(secondsUntilChange([r], at(1, '10:30')), 30 * 60));
  check('в 11:30 до следующего начала 20.5 часов', () => assert.strictEqual(secondsUntilChange([r], at(1, '11:30')), 20.5 * 3600));
  check('без правил границы нет', () => assert.strictEqual(secondsUntilChange([], at(1, '11:30')), null));

  const night = rule([5], '22:00:00', '02:00:00');
  check('суббота 00:30 — до конца ночного интервала 1.5 часа', () => assert.strictEqual(secondsUntilChange([night], at(6, '00:30')), 1.5 * 3600));
}

console.log('Ближайшее открытие — для сообщения «откроем в 8:00»');
{
  const r = rule([1, 2, 3, 4, 5], '08:00:00', '11:00:00');
  check('понедельник 03:00 → 08:00 сегодня', () => assert.strictEqual(availability.secondsToTime(nextOpeningSeconds([r], at(1, '03:00'))), '08:00'));
  check('пятница 20:00 → 08:00 (в понедельник)', () => assert.strictEqual(availability.secondsToTime(nextOpeningSeconds([r], at(5, '20:00'))), '08:00'));
}

console.log('Пересечения интервалов (предупреждение в админке)');
{
  check('08:00–11:00 и 11:00–15:00 не пересекаются', () => assert.strictEqual(
    availability.hasOverlaps([rule([1], '08:00:00', '11:00:00'), rule([1], '11:00:00', '15:00:00')]),
    false
  ));
  check('08:00–12:00 и 11:00–15:00 пересекаются', () => assert.strictEqual(
    availability.hasOverlaps([rule([1], '08:00:00', '12:00:00'), rule([1], '11:00:00', '15:00:00')]),
    true
  ));
  check('разные дни не пересекаются', () => assert.strictEqual(
    availability.hasOverlaps([rule([1], '08:00:00', '12:00:00'), rule([2], '08:00:00', '12:00:00')]),
    false
  ));
  check('вс 23:00–01:00 пересекается с пн 00:00–02:00 (стык недели)', () => assert.strictEqual(
    availability.hasOverlaps([rule([7], '23:00:00', '01:00:00'), rule([1], '00:00:00', '02:00:00')]),
    true
  ));
}

console.log('Часовой пояс заведения');
{
  // 2026-09-08T20:30:00Z — это уже 09 сентября 01:30 в Ташкенте (UTC+5), среда.
  const moment = new Date('2026-09-08T20:30:00Z');
  const tashkent = venueNow('Asia/Tashkent', moment);
  check('Ташкент: среда 01:30', () => assert.deepStrictEqual(
    { weekday: tashkent.weekday, time: availability.secondsToTime(tashkent.seconds) },
    { weekday: 3, time: '01:30' }
  ));

  const utc = venueNow('UTC', moment);
  check('UTC: вторник 20:30', () => assert.deepStrictEqual(
    { weekday: utc.weekday, time: availability.secondsToTime(utc.seconds) },
    { weekday: 2, time: '20:30' }
  ));

  const broken = venueNow('Nowhere/Nothing', moment);
  check('неизвестная зона — падаем на Asia/Tashkent, а не на исключение', () => assert.strictEqual(broken.timezone, 'Asia/Tashkent'));

  // Полночь: hourCycle h23 обязан дать 00, а не 24.
  const midnight = venueNow('Asia/Tashkent', new Date('2026-09-08T19:00:00Z'));
  check('полночь = 00:00, а не 24:00', () => assert.strictEqual(availability.secondsToTime(midnight.seconds), '00:00'));
}

console.log(`\nпроверок пройдено: ${passed}`);
if (process.exitCode) console.error('есть падения — см. FAIL выше');
