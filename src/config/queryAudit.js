const env = require('./env');

// Промт 3.6: «Добавь middleware, который в dev-режиме логирует запросы к моделям без venue_id,
// чтобы такие места было видно».
//
// Это ПОДСКАЗКА, а не проверка. Ложные срабатывания здесь ожидаемы и допустимы: задача аудита —
// сделать сомнительные места видимыми, а решение по каждому принимает человек. Настоящая
// гарантия изоляции — эмпирическая, scripts/check-venue-isolation.js.
//
// Работает только вне production и только при QUERY_AUDIT=1: это диагностический инструмент,
// а не часть рантайма, и в проде он не должен ни тратить такт на каждом запросе, ни писать в лог.

// Таблицы, строки которых принадлежат конкретному заведению. venues и site_settings сюда
// не входят: первая и есть заведение, вторая — общая для сервиса.
const VENUE_SCOPED_TABLES = [
  'items', 'categories', 'venue_tables', 'reviews', 'orders', 'order_items', 'waiter_calls',
  'menu_events', 'menu_stats_daily', 'availability_schedules', 'item_option_groups',
  'item_options', 'admin_action_logs', 'venue_page_views', 'admin_session_hashes',
  'venue_status_history', 'payments', 'payment_claims', 'admin_venues', 'venue_domains',
];

const seen = new Set();

// Границы слова записаны явным классом символов, а не \b: так регулярка читается однозначно
// и не зависит от того, каким инструментом файл редактировали (однажды \b здесь уже успел
// превратиться в символ backspace, и проверка молча перестала срабатывать).
const WORD_EDGE = '(?:^|[^a-z_])';

// Запрос считается ограниченным заведением, если venue_id участвует в ФИЛЬТРАЦИИ — в WHERE,
// в условии JOIN, в списке колонок INSERT или в SET, — а не просто попал в список выбираемых
// колонок.
//
// Различие существенное: `SELECT i.*, c.venue_id FROM items i JOIN categories c
// ON c.id = i.category_id WHERE i.id = $1` отдаёт строку ЛЮБОГО заведения и полагается на то,
// что вызывающий код сверит venue_id сам (так устроены loadOwnItem и его аналоги). Это законный
// приём, но аудит обязан его показывать, а не считать безопасным по одному упоминанию колонки.
function looksVenueScoped(sql) {
  const lower = sql.replace(/\s+/g, ' ').toLowerCase();

  // Часть после первого WHERE/HAVING — там живут настоящие фильтры.
  const whereIndex = lower.search(new RegExp(`${WORD_EDGE}(where|having)(?![a-z_])`));
  if (whereIndex >= 0 && /venue_id|venue_slug/.test(lower.slice(whereIndex))) return true;

  // Условие соединения: JOIN ... ON ... venue_id — тоже ограничение, а не выбор колонки.
  if (new RegExp(`${WORD_EDGE}on(?![a-z_])[^()]*venue_id`).test(lower)) return true;

  // INSERT/UPDATE, в которых venue_id указан явно, — запись в конкретное заведение.
  if (/insert\s+into[^(]*\([^)]*venue_id/.test(lower)) return true;
  if (new RegExp(`${WORD_EDGE}set(?![a-z_])[^;]*venue_id\\s*=`).test(lower)) return true;

  return false;
}

function touchedVenueTables(sql) {
  const lower = sql.toLowerCase();
  return VENUE_SCOPED_TABLES.filter((table) => (
    // Границы слова, иначе 'items' совпал бы внутри 'order_items' и наоборот.
    new RegExp(`${WORD_EDGE}${table}(?![a-z_])`).test(lower)
  ));
}

// Короткая подпись запроса — чтобы один и тот же SQL не писался в лог сотню раз за прогон.
function signature(sql) {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Оборачивает pool.query. Возвращает функцию отключения — нужна проверкам, которые не должны
// засорять свой вывод чужими предупреждениями.
function install(pool) {
  if (env.isProduction || process.env.QUERY_AUDIT !== '1') return () => {};

  const original = pool.query.bind(pool);

  // eslint-disable-next-line no-param-reassign
  pool.query = function auditedQuery(...args) {
    const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
    const tables = touchedVenueTables(sql);

    if (tables.length > 0 && !looksVenueScoped(sql)) {
      const key = signature(sql);
      if (!seen.has(key)) {
        seen.add(key);
        // Стек обрезан до первых кадров своего кода — важно, ОТКУДА пришёл запрос,
        // а не как он прошёл через драйвер и через саму обёртку.
        const stack = (new Error().stack || '').split('\n')
          .filter((line) => (
            line.includes(process.cwd())
            && !line.includes('node_modules')
            && !line.includes('queryAudit.js')
          ))
          .slice(0, 3)
          .map((line) => line.trim().replace(process.cwd(), '.'));

        console.warn(
          `[query-audit] запрос к ${tables.join(', ')} без фильтра по заведению:\n`
          + `  ${key}\n`
          + (stack.length ? `${stack.map((line) => `  ${line}`).join('\n')}\n` : '')
        );
      }
    }

    return original(...args);
  };

  return () => {
    // eslint-disable-next-line no-param-reassign
    pool.query = original;
    seen.clear();
  };
}

module.exports = { install, touchedVenueTables, looksVenueScoped, VENUE_SCOPED_TABLES };
