(function () {
  // Корзина публичного меню и модалка выбора опций (промт 2.1). Данные о позициях и все
  // переводы приходят одним JSON-блоком из шаблона (#menuData) — сам файл не содержит
  // ни одной зашитой строки интерфейса и ни одного серверного шаблонного тега.
  var dataEl = document.getElementById('menuData');
  if (!dataEl) return;

  var DATA = JSON.parse(dataEl.textContent);
  var L = DATA.labels;
  var STORAGE_KEY = 'cart:' + DATA.slug;

  var cart = {};

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function fmt(n) {
    return Math.round(n).toLocaleString('ru-RU');
  }

  // Ключ строки корзины: позиция без опций — просто её id (поведение как раньше), позиция
  // с опциями — id плюс отсортированный список выбранных option_id. Отсортированный список
  // и есть та самая стабильная "подпись" набора: один и тот же набор всегда даёт один ключ,
  // разные наборы — разные строки корзины.
  function lineKey(itemId, optionIds) {
    if (!optionIds || optionIds.length === 0) return String(itemId);
    return itemId + ':' + optionIds.slice().sort(function (a, b) { return a - b; }).join('-');
  }

  function itemById(id) {
    return DATA.items[String(id)] || null;
  }

  function optionById(item, optionId) {
    for (var i = 0; i < item.groups.length; i += 1) {
      var options = item.groups[i].options;
      for (var j = 0; j < options.length; j += 1) {
        if (options[j].id === optionId) return options[j];
      }
    }
    return null;
  }

  function loadCart() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      cart = raw ? JSON.parse(raw) : {};
    } catch (e) {
      cart = {};
    }
  }

  function saveCart() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch (e) {}
  }

  // Корзина лежит в sessionStorage и переживает изменения меню владельцем: при каждой загрузке
  // сверяем её с актуальными данными — исчезнувшие/ставшие недоступными опции убираем, цены
  // пересчитываем по текущим (промт 2.1, edge cases). Молча меняем только суммы; если пропали
  // опции или сама позиция — показываем ненавязчивое уведомление.
  function validateCart() {
    var changed = false;
    var optionsLost = false;
    var next = {};

    Object.keys(cart).forEach(function (key) {
      var line = cart[key];
      var item = itemById(line.itemId);
      if (!item) {
        changed = true;
        optionsLost = true;
        return;
      }

      var keptIds = [];
      (line.optionIds || []).forEach(function (optionId) {
        var option = optionById(item, optionId);
        if (option && option.isAvailable) keptIds.push(optionId);
        else { changed = true; optionsLost = true; }
      });

      var priced = priceFor(item, keptIds);
      var newKey = lineKey(item.id, keptIds);
      if (priced.price !== line.price || newKey !== key) changed = true;

      // Если после чистки набор совпал с уже существующей строкой — складываем количества.
      if (next[newKey]) {
        next[newKey].qty = Math.min(99, next[newKey].qty + line.qty);
      } else {
        next[newKey] = {
          itemId: item.id,
          qty: line.qty,
          name: item.name,
          price: priced.price,
          currency: item.currency,
          optionIds: keptIds,
          optionsLabel: priced.label,
        };
      }
    });

    cart = next;
    if (changed) saveCart();
    if (optionsLost) showCartNotice();
  }

  function showCartNotice() {
    var note = document.getElementById('cartChangedNote');
    if (!note) return;
    note.hidden = false;
  }

  function priceFor(item, optionIds) {
    var price = Number(item.price);
    var names = [];
    (optionIds || []).forEach(function (optionId) {
      var option = optionById(item, optionId);
      if (!option) return;
      price += option.priceDelta;
      names.push(option.name);
    });
    return { price: price, label: names.join(', ') };
  }

  function totalCount() {
    return Object.keys(cart).reduce(function (sum, key) { return sum + cart[key].qty; }, 0);
  }

  function totalSum() {
    return Object.keys(cart).reduce(function (sum, key) { return sum + cart[key].price * cart[key].qty; }, 0);
  }

  // Степперы в строках меню показывают суммарное количество позиции во ВСЕХ её вариантах —
  // у позиции с опциями степпера нет вовсе (там кнопка открывает модалку), так что это
  // касается только позиций без групп.
  function renderSteppers() {
    document.querySelectorAll('.cart-control[data-item-id]').forEach(function (el) {
      var entry = cart[el.dataset.itemId];
      var qty = entry ? entry.qty : 0;
      var valueEl = el.querySelector('.qty-value');
      if (valueEl) valueEl.textContent = qty;
      el.classList.toggle('has-qty', qty > 0);
    });
  }

  function renderBar(changed) {
    var bar = document.getElementById('cartBar');
    if (!bar) return;
    var count = totalCount();
    if (count === 0) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    document.getElementById('cartBarCount').textContent = count;
    document.getElementById('cartBarItemsLabel').textContent = L.itemsCount.replace('__COUNT__', count);
    document.getElementById('cartBarTotal').textContent = fmt(totalSum());
    if (changed && window.publicMenuPulseCart) window.publicMenuPulseCart();
    if (changed && window.publicMenuFlashBadge) window.publicMenuFlashBadge();
  }

  function renderPanel() {
    var list = document.getElementById('cartPanelList');
    if (!list) return;
    var keys = Object.keys(cart).filter(function (key) { return cart[key].qty > 0; });
    if (keys.length === 0) {
      list.innerHTML = '<p class="cart-empty-note">' + escapeHtml(L.cartEmpty) + '</p>';
      return;
    }
    list.innerHTML = keys.map(function (key) {
      var entry = cart[key];
      var editable = entry.optionIds && entry.optionIds.length > 0;
      return '<div class="cart-line" data-line-key="' + escapeHtml(key) + '">' +
        '<span class="cart-line-name">' + escapeHtml(entry.name) +
          (entry.optionsLabel ? '<span class="cart-line-options">' + escapeHtml(entry.optionsLabel) + '</span>' : '') +
          (editable ? '<button type="button" class="cart-line-edit" data-edit-line="' + escapeHtml(key) + '">' + escapeHtml(L.editLine) + '</button>' : '') +
        '</span>' +
        '<div class="qty-stepper has-qty" data-line-key="' + escapeHtml(key) + '">' +
          '<button type="button" class="qty-btn qty-minus" aria-label="' + escapeHtml(L.qtyDecrease) + '">−</button>' +
          '<span class="qty-value">' + entry.qty + '</span>' +
          '<button type="button" class="qty-btn qty-plus" aria-label="' + escapeHtml(L.qtyIncrease) + '">+</button>' +
        '</div>' +
        '<strong class="cart-line-total">' + fmt(entry.price * entry.qty) + ' ' + escapeHtml(entry.currency) + '</strong>' +
      '</div>';
    }).join('');
  }

  function render(changed) {
    renderSteppers();
    renderBar(changed);
    renderPanel();
  }

  function changeQty(key, delta, meta) {
    var existing = cart[key];
    var previousQty = existing ? existing.qty : 0;
    var itemId = existing ? existing.itemId : (meta && meta.itemId);
    var qty = Math.max(0, Math.min(99, previousQty + delta));
    if (qty === 0) {
      delete cart[key];
    } else if (existing) {
      existing.qty = qty;
    } else if (meta) {
      cart[key] = {
        itemId: meta.itemId,
        qty: qty,
        name: meta.name,
        price: meta.price,
        currency: meta.currency,
        optionIds: meta.optionIds || [],
        optionsLabel: meta.optionsLabel || '',
      };
    }
    saveCart();
    render(true);
    // Промт 3.2: item_add/item_remove — именно переход через ноль ("положил"/"убрал совсем"),
    // а не каждый тап по степперу — иначе "топ-10 добавляемых в корзину" считал бы того, кто
    // взял один пирожок, теми же весами, что и того, кто пять раз потыкал "+" одному и тому же.
    if (window.eventTracker && itemId !== undefined) {
      if (previousQty === 0 && qty > 0) window.eventTracker.track('item_add', { item_id: itemId });
      else if (previousQty > 0 && qty === 0) window.eventTracker.track('item_remove', { item_id: itemId });
    }
  }

  // ---- модалка выбора опций -----------------------------------------------------------

  var modal = document.getElementById('item-options-modal');
  var modalState = { itemId: null, editingKey: null };

  // Рендер групп работает с любым контейнером — одна и та же разметка и одни и те же правила
  // используются и в быстрой модалке выбора, и в карточке блюда (промт 2.2).
  function selectedIdsIn(container) {
    var inputs = container.querySelectorAll('.option-choice-input:checked');
    return Array.prototype.map.call(inputs, function (input) { return Number(input.value); });
  }

  function selectedIdsFromForm() {
    return selectedIdsIn(modal);
  }

  function optionGroupsHtml(item, preselectedIds) {
    return item.groups.map(function (group) {
      var requiredMark = (group.isRequired || group.minSelect > 0)
        ? '<span class="option-required-mark">' + escapeHtml(L.required) + '</span>' : '';
      var inputType = group.selection === 'single' ? 'radio' : 'checkbox';
      var namePrefix = 'group-' + group.id + '-' + Math.random().toString(36).slice(2, 8);
      var options = group.options.map(function (option) {
        var checked = preselectedIds.indexOf(option.id) !== -1;
        var delta = option.priceDelta > 0 ? '<span class="option-choice-price">+' + fmt(option.priceDelta) + '</span>' : '';
        return '<label class="option-choice' + (option.isAvailable ? '' : ' is-unavailable') + '">' +
          '<input class="option-choice-input" type="' + inputType + '" name="' + namePrefix + '" value="' + option.id + '"' +
            (checked && option.isAvailable ? ' checked' : '') +
            (option.isAvailable ? '' : ' disabled data-unavailable="1"') + '>' +
          '<span class="option-choice-name">' + escapeHtml(option.name) + '</span>' + delta +
        '</label>';
      }).join('');
      return '<div class="option-choice-group" data-group-id="' + group.id + '">' +
        '<div class="option-choice-head"><b>' + escapeHtml(group.name) + '</b>' + requiredMark + '</div>' +
        options +
        '<p class="option-group-max-hint" hidden>' + escapeHtml(L.maxReached) + '</p>' +
      '</div>';
    }).join('');
  }

  // Пересчёт состояния выбора в конкретном контейнере: блокировка чекбоксов при достижении
  // максимума, доступность кнопки и итоговая цена на ней.
  function refreshSelectionState(container, item, submitBtn) {
    var selectedIds = selectedIdsIn(container);
    var priced = priceFor(item, selectedIds);

    item.groups.forEach(function (group) {
      if (group.selection !== 'multiple' || group.maxSelect === null) return;
      var groupEl = container.querySelector('[data-group-id="' + group.id + '"]');
      if (!groupEl) return;
      var inputs = groupEl.querySelectorAll('.option-choice-input');
      var chosen = Array.prototype.filter.call(inputs, function (i) { return i.checked; }).length;
      var atMax = chosen >= group.maxSelect;
      Array.prototype.forEach.call(inputs, function (input) {
        if (!input.dataset.unavailable) input.disabled = atMax && !input.checked;
      });
      var hint = groupEl.querySelector('.option-group-max-hint');
      if (hint) hint.hidden = !atMax;
    });

    if (submitBtn) {
      submitBtn.disabled = groupValidity(item, selectedIds).length > 0;
      var totalEl = submitBtn.querySelector('.options-submit-total');
      if (totalEl) totalEl.textContent = fmt(priced.price) + ' ' + item.currency;
    }
    return priced;
  }

  function groupValidity(item, selectedIds) {
    var problems = [];
    item.groups.forEach(function (group) {
      var chosen = group.options.filter(function (o) { return selectedIds.indexOf(o.id) !== -1; }).length;
      if (group.minSelect > 0 && chosen < group.minSelect) problems.push(group.id);
      if (group.maxSelect !== null && chosen > group.maxSelect) problems.push(group.id);
    });
    return problems;
  }

  function refreshModalState() {
    var item = itemById(modalState.itemId);
    if (!item) return;
    refreshSelectionState(modal, item, modal.querySelector('#optionsSubmitBtn'));
  }

  function renderModal(item, preselectedIds) {
    modal.querySelector('#optionsModalTitle').textContent = item.name;
    var mediaEl = modal.querySelector('#optionsModalMedia');
    if (item.photoUrl) {
      mediaEl.innerHTML = '<img src="' + escapeHtml(item.photoUrl) + '" alt="' + escapeHtml(item.name) + '">';
      mediaEl.hidden = false;
    } else {
      mediaEl.innerHTML = '';
      mediaEl.hidden = true;
    }
    var descEl = modal.querySelector('#optionsModalDescription');
    descEl.textContent = item.description || '';
    descEl.hidden = !item.description;

    modal.querySelector('#optionsModalGroups').innerHTML = optionGroupsHtml(item, preselectedIds);
    refreshModalState();
  }

  function defaultSelectionFor(item) {
    var preselected = [];
    item.groups.forEach(function (group) {
      group.options.forEach(function (option) {
        if (option.isDefault && option.isAvailable) preselected.push(option.id);
      });
    });
    return preselected;
  }

  function openOptionsModal(itemId, editingKey) {
    var item = itemById(itemId);
    if (!item || !modal) return;
    modalState.itemId = itemId;
    modalState.editingKey = editingKey || null;

    var preselected = (editingKey && cart[editingKey])
      ? cart[editingKey].optionIds.slice()
      : defaultSelectionFor(item);

    renderModal(item, preselected);
    modal.querySelector('#optionsSubmitBtn .options-submit-label').textContent = editingKey ? L.saveLine : L.addToCart;
    modal.showModal();
  }

  if (modal) {
    modal.addEventListener('change', function (e) {
      if (e.target.classList && e.target.classList.contains('option-choice-input')) refreshModalState();
    });

    modal.querySelector('#optionsSubmitBtn').addEventListener('click', function () {
      var item = itemById(modalState.itemId);
      if (!item) return;
      var selectedIds = selectedIdsFromForm();
      if (groupValidity(item, selectedIds).length > 0) return;

      var priced = priceFor(item, selectedIds);
      var key = lineKey(item.id, selectedIds);

      if (modalState.editingKey && modalState.editingKey !== key) {
        // Набор опций поменяли — это другая строка корзины: переносим количество на новый ключ.
        var oldQty = cart[modalState.editingKey] ? cart[modalState.editingKey].qty : 1;
        delete cart[modalState.editingKey];
        cart[key] = {
          itemId: item.id, qty: Math.min(99, (cart[key] ? cart[key].qty : 0) + oldQty),
          name: item.name, price: priced.price, currency: item.currency,
          optionIds: selectedIds.slice().sort(function (a, b) { return a - b; }),
          optionsLabel: priced.label,
        };
        saveCart();
        render(true);
      } else if (modalState.editingKey) {
        cart[key].price = priced.price;
        cart[key].optionsLabel = priced.label;
        saveCart();
        render(true);
      } else {
        changeQty(key, 1, {
          itemId: item.id, name: item.name, price: priced.price, currency: item.currency,
          optionIds: selectedIds.slice().sort(function (a, b) { return a - b; }),
          optionsLabel: priced.label,
        });
      }

      modal.close();
    });

    // Свайп вниз закрывает bottom sheet на мобильном (на десктопе модалка центрированная,
    // жест просто не случается). Порог 70px — меньше ловит случайный скролл внутри списка.
    var touchStartY = null;
    modal.addEventListener('touchstart', function (e) {
      touchStartY = e.touches.length === 1 ? e.touches[0].clientY : null;
    }, { passive: true });
    modal.addEventListener('touchend', function (e) {
      if (touchStartY === null) return;
      var endY = e.changedTouches[0].clientY;
      var body = modal.querySelector('.modal-body');
      if (endY - touchStartY > 70 && (!body || body.scrollTop <= 0)) modal.close();
      touchStartY = null;
    });
  }

  // ---- обработчики страницы ------------------------------------------------------------

  document.addEventListener('click', function (e) {
    var optionsBtn = e.target.closest('[data-options-item-id]');
    if (optionsBtn) {
      e.preventDefault();
      openOptionsModal(Number(optionsBtn.dataset.optionsItemId), null);
      return;
    }

    var editBtn = e.target.closest('[data-edit-line]');
    if (editBtn) {
      e.preventDefault();
      var line = cart[editBtn.dataset.editLine];
      if (line) openOptionsModal(line.itemId, editBtn.dataset.editLine);
      return;
    }

    var addBtn = e.target.closest('.cart-add-btn');
    if (addBtn) {
      var addControl = addBtn.closest('.cart-control[data-item-id]');
      if (addControl) {
        e.preventDefault();
        changeQty(addControl.dataset.itemId, 1, {
          itemId: Number(addControl.dataset.itemId),
          name: addControl.dataset.itemName,
          price: parseFloat(addControl.dataset.itemPrice),
          currency: addControl.dataset.itemCurrency,
          optionIds: [],
          optionsLabel: '',
        });
      }
      return;
    }

    var qtyBtn = e.target.closest('.qty-btn');
    if (!qtyBtn) return;
    e.preventDefault();
    var stepper = qtyBtn.closest('[data-line-key]') || qtyBtn.closest('.cart-control[data-item-id]');
    if (!stepper) return;
    var delta = qtyBtn.classList.contains('qty-plus') ? 1 : -1;

    if (stepper.dataset.lineKey) {
      changeQty(stepper.dataset.lineKey, delta, null);
      return;
    }
    changeQty(stepper.dataset.itemId, delta, {
      itemId: Number(stepper.dataset.itemId),
      name: stepper.dataset.itemName,
      price: parseFloat(stepper.dataset.itemPrice),
      currency: stepper.dataset.itemCurrency,
      optionIds: [],
      optionsLabel: '',
    });
  });

  var barToggle = document.getElementById('cartBarToggle');
  if (barToggle) {
    barToggle.addEventListener('click', function () {
      var dialog = document.getElementById('cart-modal');
      if (dialog) dialog.showModal();
      if (window.eventTracker) window.eventTracker.track('cart_open');
    });
  }

  var clearBtn = document.getElementById('cartClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      cart = {};
      saveCart();
      render(true);
    });
  }

  loadCart();
  validateCart();
  render(false);

  // Публичный минимум для карточки блюда (dish-card.js): данные позиции, тот же рендер групп
  // опций и то же добавление в корзину — чтобы карточка не заводила вторую реализацию тех же
  // правил (валидность выбора, пересчёт цены, ключ строки).
  window.menuCart = {
    data: DATA,
    labels: L,
    getItem: itemById,
    optionGroupsHtml: optionGroupsHtml,
    defaultSelectionFor: defaultSelectionFor,
    refreshSelectionState: refreshSelectionState,
    selectedIdsIn: selectedIdsIn,
    priceFor: priceFor,
    isSelectionValid: function (item, ids) { return groupValidity(item, ids).length === 0; },
    // Промт 2.4 — экрану заказа нужен весь состав корзины и возможность очистить её после
    // успешной отправки. Отдаём копию: order-flow.js не должен править состояние напрямую.
    getCart: function () { return JSON.parse(JSON.stringify(cart)); },
    clearCart: function () {
      cart = {};
      saveCart();
      render(true);
    },
    addToCart: function (item, optionIds) {
      var priced = priceFor(item, optionIds);
      changeQty(lineKey(item.id, optionIds), 1, {
        itemId: item.id, name: item.name, price: priced.price, currency: item.currency,
        optionIds: optionIds.slice().sort(function (a, b) { return a - b; }),
        optionsLabel: priced.label,
      });
    },
    formatPrice: fmt,
  };
})();
