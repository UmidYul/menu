const { sessionHash } = require('../utils/sessionHash');
const { eventSchema } = require('../validators/eventValidators');

// Промт 3.2. session_hash одной и той же формулой (IP+UA+суточная соль) считается и для
// клиентских событий (/api/events), и для серверного page_view (publicMenu.js), и для
// admin_session_hashes (middlewares/auth.js) — только так их потом можно сопоставить друг
// с другом для фильтра "не учитывать мои просмотры".
function sessionHashFromRequest(req) {
  return sessionHash(req.ip, req.headers['user-agent']);
}

// 'qr' — гость пришёл по ссылке из QR-кода (src/routes/adminDashboard.js кодирует в QR ссылку
// с ?src=qr). 'social' — Referer с известного соцсеть-домена. 'direct' — всё остальное (набрали
// вручную, открыли из закладок/истории, реферер пустой или собственный домен).
const SOCIAL_REFERER_HOSTS = ['instagram.com', 't.me', 'telegram.org', 'facebook.com', 'tiktok.com', 'wa.me', 'whatsapp.com'];

function detectSource(req) {
  if (req.query.src === 'qr') return 'qr';
  const referer = req.get('referer') || req.get('referrer') || '';
  if (!referer) return 'direct';
  try {
    const host = new URL(referer).hostname.replace(/^www\./, '');
    if (SOCIAL_REFERER_HOSTS.some((social) => host === social || host.endsWith(`.${social}`))) return 'social';
    if (host === req.get('host')) return 'direct'; // переход внутри самого меню (категория/язык) — не "новый заход" по ссылке
  } catch {
    return 'direct';
  }
  return 'link';
}

// Грубая классификация устройства по User-Agent — только как fallback для событий, которые
// пишутся сервером до того, как успел выполниться клиентский JS (page_view). Клиентские события
// (src/public/js/event-tracker.js) присылают device сами, определённый по ширине вьюпорта —
// точнее, чем UA-сниффинг, и не путается на "десктопных" User-Agent приложений вроде Instagram
// in-app браузера на телефоне.
function detectDeviceFromUserAgent(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  if (/ipad|tablet(?!.*mobile)/.test(ua)) return 'tablet';
  if (/mobi|android|iphone/.test(ua)) return 'mobile';
  return 'desktop';
}

// Один провалидированный клиентский эвент -> строка для menuEventModel. venueId и session_hash
// подставляются здесь (клиент их не присылает — venueId уже известен из роута, session_hash
// клиент не должен даже видеть формулу вычисления).
function buildEventRow(venueId, sessionHashValue, event, lang) {
  return {
    venue_id: venueId,
    event_type: event.event_type,
    item_id: event.item_id ?? null,
    category_id: event.category_id ?? null,
    table_id: event.table_id ?? null,
    query: event.query ?? null,
    value: event.value ?? null,
    lang: event.lang ?? lang ?? null,
    source: null, // source осмыслен только для page_view — тот пишется отдельной веткой ниже
    session_hash: sessionHashValue,
    device: event.device ?? null,
  };
}

// Пачка "сырых" (ещё не провалидированных) объектов из тела запроса -> только те, что прошли
// eventSchema, остальные молча отбрасываются (промт: "валидирует, отбрасывает неизвестные
// типы") — одна битая запись не должна ронять всю пачку валидных.
function filterValidEvents(rawEvents) {
  const valid = [];
  for (const raw of rawEvents) {
    const result = eventSchema.safeParse(raw);
    if (result.success) valid.push(result.data);
  }
  return valid;
}

function buildPageViewRow(venueId, req, lang) {
  return {
    venue_id: venueId,
    event_type: 'page_view',
    item_id: null,
    category_id: null,
    table_id: null,
    query: null,
    value: null,
    lang: lang || null,
    source: detectSource(req),
    session_hash: sessionHashFromRequest(req),
    device: detectDeviceFromUserAgent(req.headers['user-agent']),
  };
}

module.exports = {
  sessionHashFromRequest,
  detectSource,
  detectDeviceFromUserAgent,
  buildEventRow,
  filterValidEvents,
  buildPageViewRow,
};
