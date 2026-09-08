// Промт 2.3 — расписание доступности категорий и позиций.
//
// Весь расчёт живёт здесь и вызывается ТОЛЬКО на сервере при рендере: если считать доступность
// на клиенте, закэшированная страница покажет завтраки в семь вечера (страница кэшируется по
// slug+lang, см. services/menuCache.js).
//
// Единица времени внутри — секунды от полуночи. Не минуты: колонка time хранит секунды, и
// округление до минут само по себе создаёт щели на границах интервалов.

const DEFAULT_TIMEZONE = 'Asia/Tashkent';
const DAY_SECONDS = 24 * 60 * 60;

// ISO: 1 = понедельник ... 7 = воскресенье. Тот же счёт, что в колонке days (см. миграцию),
// что у Postgres isodow и что мы получаем из Intl — конвертировать нигде не приходится.
const WEEKDAY_BY_SHORT_NAME = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

// Про неверную зону предупреждаем один раз на процесс, а не на каждый рендер: заведений
// с битой зоной может быть много, и лог не должен превратиться в поток одинаковых строк.
const warnedTimezones = new Set();

function isValidTimezone(timezone) {
  if (!timezone) return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch (err) {
    return false;
  }
}

function resolveTimezone(timezone) {
  if (isValidTimezone(timezone)) return timezone;
  if (timezone && !warnedTimezones.has(timezone)) {
    warnedTimezones.add(timezone);
    console.error(`availability: неизвестный часовой пояс "${timezone}", считаем по ${DEFAULT_TIMEZONE}`);
  }
  return DEFAULT_TIMEZONE;
}

// Текущий момент В ЧАСОВОМ ПОЯСЕ ЗАВЕДЕНИЯ. Через Intl с timeZone, а не через смещение числом
// (промт настаивает отдельно): смещение меняется от перехода на летнее время и от политических
// решений, а Intl берёт актуальные правила из ICU.
function venueNow(timezone, now = new Date()) {
  const tz = resolveTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // hourCycle: 'h23', а не hour12: false — последний в части реализаций отдаёт "24" вместо "00".
    hourCycle: 'h23',
  }).formatToParts(now);

  const lookup = {};
  parts.forEach((part) => { lookup[part.type] = part.value; });

  return {
    timezone: tz,
    weekday: WEEKDAY_BY_SHORT_NAME[lookup.weekday] || 1,
    seconds: Number(lookup.hour) * 3600 + Number(lookup.minute) * 60 + Number(lookup.second),
  };
}

// 'HH:MM:SS' (как отдаёт колонка time) или 'HH:MM' (как приходит из <input type="time">).
function timeToSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function secondsToTime(seconds) {
  const normalized = ((seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const hours = String(Math.floor(normalized / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((normalized % 3600) / 60)).padStart(2, '0');
  return `${hours}:${minutes}`;
}

// Длительность интервала в секундах.
//
// Здесь же живёт вся работа с переходом через полночь — промт называет это классическим багом
// и требует реализовать явно:
//   time_to > time_from  → обычный интервал внутри суток;
//   time_to < time_from  → интервал переходит на следующий день (22:00–02:00 = 4 часа);
//   time_to = time_from  → ровно сутки. Это не вырожденный случай, а способ записать
//     «круглосуточно» без щели: 00:00–23:59 давало бы разрыв в последнюю минуту суток, поэтому
//     такой ввод нормализуется в 00:00–00:00 ещё при сохранении (см. normalizeInterval).
function intervalDuration(fromSeconds, toSeconds) {
  if (toSeconds > fromSeconds) return toSeconds - fromSeconds;
  if (toSeconds === fromSeconds) return DAY_SECONDS;
  return toSeconds + DAY_SECONDS - fromSeconds;
}

// Интервал, у которого конец ровно на минуту раньше начала (классический «00:00–23:59»),
// владелец имеет в виду как круглосуточный. Приводим его к 24 часам при сохранении, а не
// подкручиваем сравнение на границе: иначе соседние интервалы 08:00–11:00 и 11:00–15:00
// начали бы пересекаться в 11:00.
function normalizeInterval(fromSeconds, toSeconds) {
  const minuteBefore = ((fromSeconds - 60) % DAY_SECONDS + DAY_SECONDS) % DAY_SECONDS;
  if (toSeconds === minuteBefore) return { from: fromSeconds, to: fromSeconds };
  return { from: fromSeconds, to: toSeconds };
}

function previousWeekday(weekday) {
  return weekday === 1 ? 7 : weekday - 1;
}

function ruleDays(rule) {
  return Array.isArray(rule.days) ? rule.days.map(Number) : [];
}

// Попадает ли текущий момент в интервал этого правила.
//
// Проверяются ДВА экземпляра интервала: начавшийся сегодня и начавшийся вчера и ещё идущий.
// Дни недели в правиле относятся ко дню НАЧАЛА интервала — «Пт 22:00–02:00» это ночь с пятницы
// на субботу, а не ночь с четверга на пятницу.
function ruleMatches(rule, now) {
  if (rule.is_active === false) return false;

  const from = timeToSeconds(rule.time_from);
  const to = timeToSeconds(rule.time_to);
  if (from === null || to === null) return false;

  const days = ruleDays(rule);
  const duration = intervalDuration(from, to);

  if (days.includes(now.weekday) && now.seconds >= from && now.seconds < from + duration) {
    return true;
  }
  // Хвост вчерашнего интервала: сегодняшняя секунда, сдвинутая на сутки вперёд, всё ещё внутри.
  return days.includes(previousWeekday(now.weekday)) && now.seconds + DAY_SECONDS < from + duration;
}

function activeRules(rules) {
  return (rules || []).filter((rule) => rule.is_active !== false);
}

// Промт: «доступна, если is_available = true И (нет расписания ИЛИ текущее время попадает
// хотя бы в один интервал)».
//
// Выключенное правило (is_active = false) считается отсутствующим, а не «запрещающим»: галочка
// рядом с интервалом означает «этот интервал сейчас не действует», и погасить ею всё меню
// навсегда владелец не должен. Поэтому набор, где все правила выключены, ведёт себя как
// «расписания нет» — про эту неочевидность админка предупреждает отдельно (scheduleWarnings).
function isAvailableNow(rules, now) {
  const active = activeRules(rules);
  if (active.length === 0) return true;
  return active.some((rule) => ruleMatches(rule, now));
}

// Все моменты смены состояния этого правила, в секундах ОТ ТЕКУЩЕГО момента.
// Считаем от «вчера» (-1), чтобы поймать конец интервала, начавшегося вчера, и на неделю
// вперёд — этого хватает для любого недельного расписания.
function ruleBoundaryOffsets(rule, now) {
  const from = timeToSeconds(rule.time_from);
  const to = timeToSeconds(rule.time_to);
  if (from === null || to === null) return [];

  const days = ruleDays(rule);
  const duration = intervalDuration(from, to);
  const offsets = [];

  for (let dayOffset = -1; dayOffset <= 7; dayOffset += 1) {
    const weekday = (((now.weekday - 1 + dayOffset) % 7) + 7) % 7 + 1;
    if (!days.includes(weekday)) continue;
    const dayStart = dayOffset * DAY_SECONDS - now.seconds;
    offsets.push(dayStart + from);
    offsets.push(dayStart + from + duration);
  }
  return offsets;
}

// Через сколько секунд доступность по этому набору правил может измениться. null — правил нет,
// то есть не изменится никогда. Используется, чтобы кэш страницы не пережил границу интервала
// (см. menuCache.set и publicMenu.js).
function secondsUntilChange(rules, now) {
  const active = activeRules(rules);
  if (active.length === 0) return null;

  let best = null;
  active.forEach((rule) => {
    ruleBoundaryOffsets(rule, now).forEach((offset) => {
      if (offset > 0 && (best === null || offset < best)) best = offset;
    });
  });
  return best;
}

// Ближайший момент, когда набор правил станет доступен. Нужен для сообщения «сейчас меню
// недоступно, откроем в 8:00»: показываем время начала, а не «через N часов».
function nextOpeningSeconds(rules, now) {
  const active = activeRules(rules);
  if (active.length === 0) return null;

  let best = null;
  active.forEach((rule) => {
    const from = timeToSeconds(rule.time_from);
    if (from === null) return;
    const days = ruleDays(rule);
    for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
      const weekday = (((now.weekday - 1 + dayOffset) % 7) + 7) % 7 + 1;
      if (!days.includes(weekday)) continue;
      const offset = dayOffset * DAY_SECONDS - now.seconds + from;
      if (offset > 0 && (best === null || offset < best)) best = offset;
    }
  });

  if (best === null) return null;
  return (now.seconds + best) % DAY_SECONDS;
}

// --- человекочитаемое описание --------------------------------------------------------------

// Подряд идущие дни сворачиваются в диапазон: [1,2,3,4,5] → «Пн–Пт», [1,3,5] → «Пн, Ср, Пт».
// Названия дней приходят снаружи (индекс 0 = понедельник) — сам сервис ничего не знает про
// словари и языки.
function formatDays(days, dayShortNames) {
  const sorted = Array.from(new Set(days.map(Number))).sort((a, b) => a - b);
  if (sorted.length === 0) return '';

  const chunks = [];
  let start = sorted[0];
  let previous = sorted[0];

  sorted.slice(1).forEach((day) => {
    if (day === previous + 1) {
      previous = day;
      return;
    }
    chunks.push([start, previous]);
    start = day;
    previous = day;
  });
  chunks.push([start, previous]);

  return chunks
    .map(([from, to]) => {
      const fromName = dayShortNames[from - 1];
      const toName = dayShortNames[to - 1];
      if (from === to) return fromName;
      // Два подряд идущих дня короче написать через запятую, чем диапазоном: «Сб, Вс».
      if (to === from + 1) return `${fromName}, ${toName}`;
      return `${fromName}–${toName}`;
    })
    .join(', ');
}

// Структурированное описание набора правил для подписи гостю и владельцу. Строку собирает
// вызывающий код через t(): здесь только данные.
function describeRules(rules, dayShortNames) {
  return activeRules(rules).map((rule) => {
    const from = timeToSeconds(rule.time_from);
    const to = timeToSeconds(rule.time_to);
    const days = ruleDays(rule);
    return {
      days: formatDays(days, dayShortNames),
      allWeek: days.length === 7,
      // Круглосуточный интервал (см. intervalDuration) подписывать «с 00:00 до 00:00» нельзя —
      // вызывающий код по этому флагу подставляет «круглосуточно».
      allDay: from !== null && from === to,
      from: from === null ? '' : secondsToTime(from),
      to: to === null ? '' : secondsToTime(to),
    };
  });
}

// --- проверки для админки -----------------------------------------------------------------

// Пересекаются ли два правила хотя бы в один момент недели. Сравниваем не «дни и часы
// по отдельности», а реальные отрезки на недельной шкале (0..7*24ч), развёрнутые по дням —
// иначе интервал через полночь в пятницу и утренний субботний считались бы непересекающимися.
function weekSegments(rule) {
  const from = timeToSeconds(rule.time_from);
  const to = timeToSeconds(rule.time_to);
  if (from === null || to === null) return [];
  const duration = intervalDuration(from, to);

  return ruleDays(rule).map((day) => {
    const start = (day - 1) * DAY_SECONDS + from;
    return { start, end: start + duration };
  });
}

const WEEK_SECONDS = 7 * DAY_SECONDS;

function segmentsOverlap(a, b) {
  // Неделя циклична: отрезок, вылезающий за воскресенье, продолжается в понедельник. Поэтому
  // каждый отрезок проверяем и как есть, и сдвинутым на неделю в обе стороны.
  for (const shift of [-WEEK_SECONDS, 0, WEEK_SECONDS]) {
    if (a.start < b.end + shift && b.start + shift < a.end) return true;
  }
  return false;
}

function hasOverlaps(rules) {
  const all = [];
  activeRules(rules).forEach((rule) => {
    weekSegments(rule).forEach((segment) => all.push(segment));
  });

  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (segmentsOverlap(all[i], all[j])) return true;
    }
  }
  return false;
}

// Предупреждения владельцу при сохранении (промт: «если интервалы пересекаются или если
// получилось, что позиция недоступна никогда»).
//
// Буквального состояния «недоступна никогда» в схеме получиться не может: пустой список дней
// и значения вне 1..7 отсекает CHECK, нулевой интервал нормализуется в круглосуточный, а
// расписание позиции полностью заменяет расписание категории, так что «непересекающиеся
// расписания» тоже неоткуда взять. Реально владелец может получить два других расхождения
// между тем, что он видит в форме, и тем, что увидит гость, — про них и предупреждаем.
function scheduleWarnings(rules, { isAvailable } = {}) {
  const warnings = [];
  const list = rules || [];

  if (hasOverlaps(list)) warnings.push('overlap');
  // Выбрано «по расписанию», но действующих интервалов не осталось: по правилу выше это
  // означает «доступно всегда» — совсем не то, что владелец видит на экране.
  if (list.length > 0 && activeRules(list).length === 0) warnings.push('noActiveIntervals');
  // Позиция снята с продажи целиком — расписание к ней просто не применяется.
  if (list.length > 0 && isAvailable === false) warnings.push('itemDisabled');

  return warnings;
}

module.exports = {
  DEFAULT_TIMEZONE,
  DAY_SECONDS,
  isValidTimezone,
  venueNow,
  timeToSeconds,
  secondsToTime,
  intervalDuration,
  normalizeInterval,
  ruleMatches,
  isAvailableNow,
  secondsUntilChange,
  nextOpeningSeconds,
  formatDays,
  describeRules,
  hasOverlaps,
  scheduleWarnings,
};
