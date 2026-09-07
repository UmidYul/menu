const { todayUTC, diffDaysUTC, truncateToDateUTC } = require('../utils/dateOnly');

const MIN_ITEMS_FOR_CHECKLIST = 5;
const MIN_PHOTOS_FOR_CHECKLIST = 3;
const EXPANDED_DAYS_AFTER_PUBLISH = 14;

const CHECKLIST_ORDER = [
  'profile', 'contacts', 'category', 'items', 'photos', 'preview', 'publish', 'qr', 'telegram',
];

// Порядок пунктов фиксирован промтом 1.6 — "текущий" шаг для акцента в UI это первый
// невыполненный ПО ЭТОМУ порядку, а не по хронологии того, что владелец делал в реальности.
function buildChecklist(venue, counts) {
  const doneByKey = {
    profile: Boolean(venue.logo_url) && Boolean(venue.description_ru || venue.description_uz || venue.description_en),
    contacts: Boolean(venue.phone) && Boolean(venue.address) && Boolean(venue.working_hours),
    category: counts.category_count > 0,
    items: counts.item_count >= MIN_ITEMS_FOR_CHECKLIST,
    photos: counts.photo_count >= MIN_PHOTOS_FOR_CHECKLIST,
    preview: Boolean(venue.menu_previewed_at),
    publish: venue.status !== 'draft',
    qr: Boolean(venue.qr_downloaded_at),
    telegram: Boolean(counts.has_telegram),
  };

  // href — простая ссылка-переход для пунктов, где действие это просто "перейди и сделай".
  // publish/qr рендерятся в dashboard.ejs особым образом (форма публикации / ссылка-скачивание
  // с download-атрибутом) — этот href для них не используется, но остаётся для единообразия структуры.
  const hrefByKey = {
    profile: '/admin/venue-settings',
    contacts: '/admin/venue-settings',
    category: '/admin/categories',
    items: '/admin/items',
    photos: '/admin/items',
    preview: '/admin/preview-menu',
    publish: '/admin',
    qr: '/admin',
    telegram: '/admin/password',
  };

  const iconByKey = {
    profile: 'store',
    contacts: 'phone',
    category: 'list',
    items: 'utensils',
    photos: 'image',
    preview: 'eye',
    publish: 'externallink',
    qr: 'qrcode',
    telegram: 'telegram',
  };

  const firstNotDoneIndex = CHECKLIST_ORDER.findIndex((key) => !doneByKey[key]);

  const items = CHECKLIST_ORDER.map((key, index) => ({
    key,
    done: doneByKey[key],
    current: index === firstNotDoneIndex,
    href: hrefByKey[key],
    icon: iconByKey[key],
  }));

  const doneCount = items.filter((item) => item.done).length;

  return { items, doneCount, total: items.length, allDone: firstNotDoneIndex === -1 };
}

// Развёрнуто по умолчанию: пока не всё выполнено, и первые 14 дней после публикации (промт 1.6).
// Ручное сворачивание (см. src/routes/adminDashboard.js) переживает это правило кукой с
// doneCount на момент сворачивания — если что-то из уже выполненного потом перестало быть
// выполненным (например, удалили все позиции), doneCount падает НИЖЕ сохранённого значения,
// и блок разворачивается заново, даже если кука всё ещё говорит "свёрнуто".
function isExpandedByDefault(venue, checklist) {
  if (!checklist.allDone) return true;
  if (!venue.published_at) return false;
  const daysSincePublish = diffDaysUTC(todayUTC(), truncateToDateUTC(new Date(venue.published_at)));
  return daysSincePublish <= EXPANDED_DAYS_AFTER_PUBLISH;
}

function isCollapsedByCookie(collapsedAtDoneCount, currentDoneCount) {
  if (collapsedAtDoneCount === null || collapsedAtDoneCount === undefined) return false;
  return currentDoneCount >= collapsedAtDoneCount;
}

module.exports = {
  MIN_ITEMS_FOR_CHECKLIST,
  MIN_PHOTOS_FOR_CHECKLIST,
  buildChecklist,
  isExpandedByDefault,
  isCollapsedByCookie,
};
