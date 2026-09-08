const crypto = require('crypto');
const { pool } = require('../config/db');

// Промт 3.7. Свои домены заведений.
//
// Максимум два домена на заведение обеспечивает не этот файл, а уникальный индекс
// (venue_id, is_primary) из миграции 1787508500000: считать строки перед вставкой — гонка
// двух вкладок, а индекс не обойти. Здесь ошибка уникальности только переводится в понятный
// код, с которым роут умеет работать.

const STATUSES = ['pending', 'verifying', 'active', 'failed', 'disabled'];

const COLUMNS = `id, venue_id, domain, status, verification_token, verified_at,
                 last_check_at, last_error, is_primary, check_attempts, next_check_at, created_at`;
// То же самое с префиксом таблицы — для запросов с JOIN. Список выписан второй раз целиком,
// а не собирается из COLUMNS склейкой строк: склейка выглядит короче ровно до первого раза,
// когда в неё придётся заглянуть, чтобы понять, какие колонки в итоге выбираются.
const D_COLUMNS = `d.id, d.venue_id, d.domain, d.status, d.verification_token, d.verified_at,
                   d.last_check_at, d.last_error, d.is_primary, d.check_attempts, d.next_check_at,
                   d.created_at`;

// Токен для TXT-записи. Префикс нужен, чтобы владелец (и мы при разборе) отличали нашу запись
// от чужих TXT в той же зоне: у домена их обычно несколько (SPF, верификации почты и прочее).
const TOKEN_PREFIX = 'qrmenu-verify=';

function generateToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
}

async function listForVenue(venueId) {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM venue_domains WHERE venue_id = $1 ORDER BY is_primary DESC, domain`,
    [venueId]
  );
  return result.rows;
}

// Все активные домены разом — для прогрева кэша маршрутизации по хосту (services/domainCache.js).
// Отдаёт и slug заведения: middleware по домену обязан сразу знать, чьё меню рендерить,
// и второй запрос на каждый запрос гостя тут недопустим.
async function listActiveWithVenue() {
  const result = await pool.query(
    `SELECT d.domain, d.venue_id, d.is_primary, v.slug
     FROM venue_domains d
     JOIN venues v ON v.id = d.venue_id
     WHERE d.status = 'active'`
  );
  return result.rows;
}

async function findByDomain(domain) {
  const result = await pool.query(`SELECT ${COLUMNS} FROM venue_domains WHERE domain = $1`, [domain]);
  return result.rows[0] || null;
}

// venue_id в WHERE (правило проекта и промта 3.6): владение проверяется в самом запросе,
// а не только в предыдущей выборке.
async function findByIdForVenue(id, venueId) {
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM venue_domains WHERE id = $1 AND venue_id = $2`,
    [id, venueId]
  );
  return result.rows[0] || null;
}

// Возвращает { domain } либо { error } с кодом:
//   'taken'     — домен уже занят (этим же или другим заведением);
//   'too_many'  — у заведения уже есть основной и алиас.
// Промт: «Домен уже используется другим заведением — ошибка на этапе добавления, а не на этапе
// выпуска». Оба случая распознаются по имени нарушенного ограничения, а не отдельным SELECT'ом
// перед вставкой: между таким SELECT'ом и INSERT'ом домен успевает занять кто угодно.
async function add({ venueId, domain, isPrimary }) {
  try {
    const result = await pool.query(
      `INSERT INTO venue_domains (venue_id, domain, verification_token, is_primary)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [venueId, domain, generateToken(), isPrimary]
    );
    return { domain: result.rows[0] };
  } catch (err) {
    if (err.code !== '23505') throw err;
    if (err.constraint === 'venue_domains_venue_id_is_primary_key') return { error: 'too_many' };
    return { error: 'taken' };
  }
}

async function remove(id, venueId) {
  const result = await pool.query(
    'DELETE FROM venue_domains WHERE id = $1 AND venue_id = $2 RETURNING id, domain, status',
    [id, venueId]
  );
  return result.rows[0] || null;
}

// --- переходы статусов ------------------------------------------------------------------------
//
// У функций ниже НЕТ параметра venueId, и это осознанное исключение из правила «venue_id в WHERE
// самой мутации» (промт 3.6). QUERY_AUDIT честно их помечает — вот почему они всё равно такие:
//
// ни одна из них не достижима из запроса администратора. Их зовут только планировщик
// (services/domainVerification.js, перебирающий строки, которые сам же и выбрал) и скрипт
// выпуска сертификата (scripts/domain-cert-hook.js, который знает домен — а домен уникален
// глобально). Активного заведения в этих контекстах не существует вовсе, и подставлять туда
// venue_id было бы не защитой, а выдумыванием ограничения из воздуха.
//
// Всё, что вызывается ИЗ АДМИНКИ, — requestImmediateCheck, retry, remove, findByIdForVenue —
// venueId принимает и ставит его в WHERE.

// Успешная проверка DNS. Из 'pending' домен уходит в 'verifying' — ждать сертификат
// (его выпускает scripts/issue-cert.sh, см. README), а не сразу в 'active': пустить трафик
// на домен без сертификата значит показать гостю предупреждение браузера вместо меню.
async function markVerifying(id) {
  const result = await pool.query(
    `UPDATE venue_domains
     SET status = 'verifying', verified_at = now(), last_check_at = now(),
         last_error = NULL, check_attempts = 0, next_check_at = now()
     WHERE id = $1 AND status IN ('pending', 'failed')
     RETURNING ${COLUMNS}`,
    [id]
  );
  return result.rows[0] || null;
}

// Сертификат выпущен — домен пошёл в работу. Вызывается скриптом выпуска, поэтому переход
// разрешён только из 'verifying': активировать домен, DNS которого никто не проверял, нельзя.
async function markActive(id) {
  const result = await pool.query(
    `UPDATE venue_domains
     SET status = 'active', last_check_at = now(), last_error = NULL, check_attempts = 0
     WHERE id = $1 AND status = 'verifying'
     RETURNING ${COLUMNS}`,
    [id]
  );
  return result.rows[0] || null;
}

// Неудачная попытка: запоминаем причину и отодвигаем следующую проверку. Сам отступ считает
// вызывающий код (services/domainVerification.js) — он же знает про потолок и про 48 часов.
async function recordFailure(id, { error, nextCheckAt, attempts }) {
  const result = await pool.query(
    `UPDATE venue_domains
     SET last_check_at = now(), last_error = $2, check_attempts = $3, next_check_at = $4
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, error, attempts, nextCheckAt]
  );
  return result.rows[0] || null;
}

// Промт: «остановкой через 48 часов с переводом в 'failed'». Отдельно от recordFailure:
// это не «ещё одна неудача», а конец попыток, и статус здесь меняется.
async function markFailed(id, error) {
  const result = await pool.query(
    `UPDATE venue_domains
     SET status = 'failed', last_check_at = now(), last_error = $2
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, error]
  );
  return result.rows[0] || null;
}

// Домены, которым пора на проверку. Порядок по next_check_at — самый просроченный первым,
// чтобы при накопившейся очереди никто не голодал.
async function listDueForCheck(limit) {
  const result = await pool.query(
    `SELECT ${D_COLUMNS},
            v.name AS venue_name, v.lang_default, v.email, v.owner_telegram_id
     FROM venue_domains d
     JOIN venues v ON v.id = d.venue_id
     WHERE d.status IN ('pending', 'verifying')
       AND d.next_check_at <= now()
     ORDER BY d.next_check_at
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Активные домены тоже проверяются, но реже: промт требует заметить, что заведение убрало
// запись из DNS, не отключив домен в админке. Такой домен переводится в 'failed' через сутки,
// а меню продолжает работать на основном адресе.
async function listActiveForRecheck(limit, staleBefore) {
  const result = await pool.query(
    `SELECT ${D_COLUMNS},
            v.name AS venue_name, v.lang_default, v.email, v.owner_telegram_id
     FROM venue_domains d
     JOIN venues v ON v.id = d.venue_id
     WHERE d.status = 'active'
       AND (d.last_check_at IS NULL OR d.last_check_at < $2)
     ORDER BY d.last_check_at NULLS FIRST
     LIMIT $1`,
    [limit, staleBefore]
  );
  return result.rows;
}

// «Проверить сейчас» из админки — просто передвигает срок проверки на сейчас, а саму проверку
// делает планировщик. Так у ручной и автоматической проверки одна и та же реализация, и кнопка
// не может проверить домен как-то иначе, чем это будет происходить дальше само.
async function requestImmediateCheck(id, venueId) {
  const result = await pool.query(
    `UPDATE venue_domains SET next_check_at = now()
     WHERE id = $1 AND venue_id = $2 AND status IN ('pending', 'verifying', 'failed', 'active')
     RETURNING ${COLUMNS}`,
    [id, venueId]
  );
  return result.rows[0] || null;
}

// Возврат из 'failed' в очередь проверок: владелец поправил DNS и нажал «Проверить снова».
async function retry(id, venueId) {
  const result = await pool.query(
    `UPDATE venue_domains
     SET status = 'pending', check_attempts = 0, next_check_at = now(), last_error = NULL
     WHERE id = $1 AND venue_id = $2 AND status = 'failed'
     RETURNING ${COLUMNS}`,
    [id, venueId]
  );
  return result.rows[0] || null;
}

module.exports = {
  STATUSES,
  TOKEN_PREFIX,
  listForVenue,
  listActiveWithVenue,
  findByDomain,
  findByIdForVenue,
  add,
  remove,
  markVerifying,
  markActive,
  recordFailure,
  markFailed,
  listDueForCheck,
  listActiveForRecheck,
  requestImmediateCheck,
  retry,
};
