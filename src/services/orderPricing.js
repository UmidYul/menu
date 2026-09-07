const itemModel = require('../models/itemModel');
const itemOptionModel = require('../models/itemOptionModel');
const { pickLocalized } = require('../utils/localize');

// Промт 2.4: «Сервер ПЕРЕСЧИТЫВАЕТ сумму по актуальным ценам и доступности. Если что-то
// изменилось — не отправлять, вернуть гостю обновлённую корзину с пояснением».
//
// Ключевой принцип: из присланного клиентом берутся ТОЛЬКО идентификаторы и количества.
// Названия, цены и надбавки читаются из БД — клиент не может ни занизить цену, ни заказать
// позицию чужого заведения, ни подсунуть опцию от другого блюда.
//
// Результат: { ok, lines, total, problems } — problems непустой означает «не отправляем,
// показываем гостю, что именно изменилось».
async function recomputeOrder(venue, lang, submittedItems) {
  const [rows, groupsByItem] = await Promise.all([
    itemModel.listByVenueGrouped(venue.id),
    itemOptionModel.listGroupsByItemForVenue(venue.id),
  ]);

  const itemsById = new Map(rows.map((row) => [row.id, row]));
  const problems = [];
  const lines = [];
  let total = 0;
  // Валюта берётся у позиций (items.currency), а не у заведения — отдельного поля валюты
  // у venues нет; в пределах одного меню она одна и та же.
  let currency = 'UZS';

  for (const submitted of submittedItems) {
    const item = itemsById.get(submitted.itemId);

    // Позиции нет в меню этого заведения: удалили, перенесли в чужое заведение или клиент
    // прислал произвольный id. Для гостя это одно и то же — «позиции больше нет».
    if (!item) {
      problems.push({ type: 'item_gone', itemId: submitted.itemId, name: null });
      continue;
    }

    const itemName = pickLocalized(item, 'name', lang);

    if (!item.is_available) {
      problems.push({ type: 'item_unavailable', itemId: item.id, name: itemName });
      continue;
    }

    const groups = groupsByItem.get(item.id) || [];
    const optionsById = new Map();
    groups.forEach((group) => group.options.forEach((option) => optionsById.set(option.id, { option, group })));

    const chosenIds = submitted.optionIds || [];
    const chosenOptions = [];
    let optionProblem = false;

    for (const optionId of chosenIds) {
      const found = optionsById.get(optionId);
      // Опция не принадлежит этому блюду (или её удалили) — не «молча игнорируем», а считаем
      // заказ изменившимся: гость выбирал конкретный состав и должен увидеть, что он поехал.
      if (!found) {
        problems.push({ type: 'option_gone', itemId: item.id, name: itemName });
        optionProblem = true;
        break;
      }
      if (!found.option.is_available) {
        problems.push({
          type: 'option_unavailable', itemId: item.id, name: itemName,
          optionName: pickLocalized(found.option, 'name', lang),
        });
        optionProblem = true;
        break;
      }
      chosenOptions.push(found);
    }
    if (optionProblem) continue;

    // Обязательные группы и лимиты — те же правила, что и в модалке выбора (промт 2.1), но
    // проверенные на сервере: клиент мог быть открыт до того, как группу сделали обязательной.
    const invalidGroup = groups.find((group) => {
      const chosenInGroup = chosenOptions.filter((entry) => entry.group.id === group.id).length;
      if (group.min_select > 0 && chosenInGroup < group.min_select) return true;
      if (group.max_select !== null && chosenInGroup > group.max_select) return true;
      return false;
    });
    if (invalidGroup) {
      problems.push({
        type: 'options_invalid', itemId: item.id, name: itemName,
        groupName: pickLocalized(invalidGroup, 'name', lang),
      });
      continue;
    }

    currency = item.currency || currency;
    const optionsTotal = chosenOptions.reduce((sum, entry) => sum + Number(entry.option.price_delta), 0);
    const unitPrice = Number(item.price) + optionsTotal;
    const lineTotal = unitPrice * submitted.qty;
    total += lineTotal;

    lines.push({
      itemId: item.id,
      name: itemName,
      qty: submitted.qty,
      unitPrice,
      lineTotal,
      // Снимок опций уходит в order_items.options_snapshot: заказ должен читаться и через
      // полгода, когда опций может уже не быть.
      options: chosenOptions.map((entry) => ({
        id: entry.option.id,
        name: pickLocalized(entry.option, 'name', lang),
        priceDelta: Number(entry.option.price_delta),
      })),
    });
  }

  return { ok: problems.length === 0 && lines.length > 0, lines, total, currency, problems };
}

module.exports = { recomputeOrder };
