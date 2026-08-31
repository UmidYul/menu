// Кириллица (русский + узбекский алфавит) -> латиница. Буквы, которых уже нет в этой таблице
// (латиница, цифры), проходят как есть — узбекские названия часто уже латиницей.
const translitMap = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
  // узбекские кириллические буквы вне русского алфавита
  ў: 'oʻ', қ: 'q', ғ: 'gʻ', ҳ: 'h',
};

function transliterate(text) {
  return String(text)
    .toLowerCase()
    .split('')
    .map((ch) => (ch in translitMap ? translitMap[ch] : ch))
    .join('');
}

// Из произвольного названия делает кандидат на slug: строчные латинские буквы, цифры, дефисы,
// без начальных/конечных/повторяющихся дефисов. Не проверяет уникальность в БД — это отдельно,
// в вызывающем коде (leadModel.generateUniqueSlug), где есть доступ к venueModel.findBySlug.
function slugify(text) {
  return transliterate(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
}

module.exports = { transliterate, slugify };
