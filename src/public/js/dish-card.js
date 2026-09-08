(function () {
  // Карточка блюда публичного меню (промт 2.2). Все данные и переводы берём из уже разобранного
  // menu-cart.js (window.menuCart) — карточка не заводит вторую реализацию правил выбора опций,
  // подсчёта цены и добавления в корзину, а переиспользует те же функции.
  var modal = document.getElementById('dish-card-modal');
  var api = window.menuCart;
  if (!modal || !api) return;

  var DATA = api.data;
  var L = api.labels;
  var mediaEl = document.getElementById('dishCardMedia');
  var photoEl = document.getElementById('dishCardPhoto');
  var bodyEl = document.getElementById('dishCardBody');
  var footEl = document.getElementById('dishCardFoot');
  var submitBtn = document.getElementById('dishCardSubmit');
  var shareBtn = document.getElementById('dishCardShare');
  var copiedNote = document.getElementById('dishCardCopied');

  var state = { itemId: null, pushed: false, open: false };
  var scrollY = 0;

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---- блокировка прокрутки фона ---------------------------------------------------------
  // position:fixed на body — единственный способ, который держит и iOS Safari; сохранённую
  // позицию обязательно возвращаем при закрытии, иначе страница прыгает в начало.

  function lockScroll() {
    scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = '-' + scrollY + 'px';
    document.body.classList.add('scroll-locked');
  }

  function unlockScroll() {
    document.body.classList.remove('scroll-locked');
    document.body.style.top = '';
    window.scrollTo(0, scrollY);
  }

  // ---- разметка карточки -----------------------------------------------------------------

  function renderPhoto(item) {
    if (!item || !item.photoUrl) {
      photoEl.className = 'dish-card-photo is-empty';
      photoEl.innerHTML = '<span class="dish-card-photo-fallback" aria-hidden="true">'
        + '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M3 2v7c0 1.1.9 2 2 2h2a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zM21 15v7"></path>'
        + '</svg></span>';
      return;
    }

    // Прогрессивная загрузка: сначала уже скачанное превью из строки меню, растянутое и размытое,
    // затем полная версия — она проявляется по событию load поверх превью.
    var thumb = item.photoThumbUrl || item.photoUrl;
    photoEl.className = 'dish-card-photo is-loading';
    photoEl.innerHTML = '<img class="dish-card-photo-preview" src="' + escapeHtml(thumb) + '" alt="" aria-hidden="true">'
      + '<img class="dish-card-photo-full" src="' + escapeHtml(item.photoUrl) + '" alt="' + escapeHtml(item.name) + '">';

    var full = photoEl.querySelector('.dish-card-photo-full');
    var done = function () { photoEl.classList.remove('is-loading'); };
    if (full.complete && full.naturalWidth > 0) done();
    else {
      full.addEventListener('load', done, { once: true });
      full.addEventListener('error', done, { once: true });
    }
  }

  function factsHtml(item) {
    var parts = [];
    if (item.weight) parts.push('<span class="dish-card-fact">' + escapeHtml(item.weight) + '</span>');
    if (item.calories) {
      parts.push('<span class="dish-card-fact">' + escapeHtml(item.calories + ' ' + L.caloriesUnit) + '</span>');
    }
    if (item.cookingTimeMinutes) {
      parts.push('<span class="dish-card-fact">'
        + escapeHtml(L.cookingTime.replace('__MINUTES__', item.cookingTimeMinutes)) + '</span>');
    }
    if (parts.length === 0) return '';
    return '<div class="dish-card-facts">' + parts.join('') + '</div>';
  }

  function tagsHtml(item) {
    var chips = (item.tags || []).map(function (tag) {
      return '<span class="dish-card-tag">' + escapeHtml(tag.label) + '</span>';
    });
    // Острота — иконками перца, ноль означает "не острое" и не рисуется вовсе.
    if (item.spicyLevel) {
      var aria = L.spicyAria.replace('__LEVEL__', item.spicyLevel).replace('__MAX__', 3);
      var peppers = '';
      for (var i = 0; i < item.spicyLevel; i += 1) peppers += '🌶';
      chips.push('<span class="dish-card-tag dish-card-spicy" title="' + escapeHtml(aria) + '">'
        + '<span aria-hidden="true">' + peppers + '</span>'
        + '<span class="sr-only">' + escapeHtml(aria) + '</span></span>');
    }
    if (chips.length === 0) return '';
    return '<div class="dish-card-tags">' + chips.join('') + '</div>';
  }

  function priceHtml(item) {
    var html = '<div class="dish-card-price">';
    if (item.oldPrice) html += '<s class="dish-old-price">' + api.formatPrice(item.oldPrice) + '</s>';
    html += '<strong>';
    if (item.priceFrom) html += '<span class="dish-price-from">' + escapeHtml(L.priceFrom || '') + '</span> ';
    html += api.formatPrice(item.price) + ' ' + escapeHtml(item.currency) + '</strong>';
    if (item.discountPercent) html += '<span class="discount-badge">−' + item.discountPercent + '%</span>';
    return html + '</div>';
  }

  // Промт 2.3. «Заказать нельзя» бывает по двум причинам, и подписи у них разные: ручной
  // рубильник владельца («нет в наличии») и расписание («доступно с 8:00 до 11:00»).
  function canOrder(item) {
    return item.isAvailable && item.availableNow !== false;
  }

  // Лента "ещё из этой категории": максимум 3 доступные позиции, текущая исключается.
  function siblingsHtml(item) {
    var siblings = (DATA.order || [])
      .map(function (id) { return api.getItem(id); })
      .filter(function (candidate) {
        return candidate && candidate.id !== item.id
          && candidate.categoryId === item.categoryId && canOrder(candidate);
      })
      .slice(0, 3);
    if (siblings.length === 0) return '';

    return '<div class="dish-card-siblings">'
      + '<h4 class="dish-card-siblings-title">' + escapeHtml(L.moreFromCategory) + '</h4>'
      + '<div class="dish-card-siblings-strip">' + siblings.map(function (sibling) {
        var media = sibling.photoThumbUrl
          ? '<img src="' + escapeHtml(sibling.photoThumbUrl) + '" alt="" loading="lazy">'
          : '<span class="dish-row-media-fallback" aria-hidden="true">🍽️</span>';
        return '<button type="button" class="dish-card-sibling" data-dish-open="' + sibling.id + '">'
          + '<span class="dish-card-sibling-media">' + media + '</span>'
          + '<span class="dish-card-sibling-name">' + escapeHtml(sibling.name) + '</span>'
          + '<span class="dish-card-sibling-price">' + api.formatPrice(sibling.price) + ' ' + escapeHtml(sibling.currency) + '</span>'
        + '</button>';
      }).join('') + '</div></div>';
  }

  function renderMissing() {
    modal.classList.add('is-gone');
    mediaEl.classList.add('is-blank');
    photoEl.className = 'dish-card-photo';
    photoEl.innerHTML = '';
    bodyEl.innerHTML = '<div class="dish-card-gone">'
      + '<p class="dish-card-gone-note">' + escapeHtml(L.gone) + '</p>'
      + '<button type="button" class="btn btn-primary" data-dish-close="1">' + escapeHtml(L.backToMenu) + '</button>'
      + '</div>';
    footEl.hidden = true;
    if (shareBtn) shareBtn.hidden = true;
  }

  function renderCard(item) {
    modal.classList.remove('is-gone');
    mediaEl.classList.remove('is-blank');
    renderPhoto(item);
    if (shareBtn) shareBtn.hidden = false;

    var html = '<h3 class="dish-card-name">' + escapeHtml(item.name)
      + (item.isPopular ? '<span class="popular-badge">' + escapeHtml(L.popular) + '</span>' : '')
      + '</h3>';
    html += priceHtml(item);
    if (item.description) html += '<p class="dish-card-description">' + escapeHtml(item.description) + '</p>';
    html += tagsHtml(item);
    html += factsHtml(item);
    if (item.composition) {
      html += '<p class="dish-card-composition"><b>' + escapeHtml(L.composition) + ':</b> '
        + escapeHtml(item.composition) + '</p>';
    }
    // Аллергенов нет — блок не рисуем совсем, никаких "не указано" (edge case промта).
    if (item.allergens && item.allergens.length > 0) {
      html += '<p class="dish-card-allergens"><b>' + escapeHtml(L.allergensPrefix) + ':</b> '
        + escapeHtml(item.allergens.join(', ')) + '</p>';
    }
    // Расписание важнее ручного рубильника в подписи: гостю полезнее узнать, что блюдо бывает
    // по утрам, чем что его нет прямо сейчас (та же логика, что в partials/dish-row.ejs).
    if (item.availableNow === false && item.scheduleLabel) {
      html += '<p class="dish-card-unavailable">'
        + escapeHtml(L.scheduleAvailableAt.replace('__SCHEDULE__', item.scheduleLabel)) + '</p>';
    } else if (!item.isAvailable) {
      html += '<p class="dish-card-unavailable">' + escapeHtml(L.unavailable) + '</p>';
    }
    if (canOrder(item) && item.groups.length > 0) {
      html += '<div class="dish-card-options" id="dishCardOptions">'
        + api.optionGroupsHtml(item, api.defaultSelectionFor(item)) + '</div>';
    }
    html += siblingsHtml(item);
    bodyEl.innerHTML = html;

    footEl.hidden = !canOrder(item);
    if (canOrder(item)) api.refreshSelectionState(bodyEl, item, submitBtn);
  }

  // ---- открытие и закрытие ---------------------------------------------------------------

  function itemUrl(itemId) {
    var url = new URL(window.location.href);
    url.searchParams.set('item', itemId);
    return url.toString();
  }

  function open(itemId, fromHistory) {
    var item = api.getItem(itemId);
    state.itemId = item ? item.id : itemId;

    if (item) {
      renderCard(item);
      if (window.eventTracker) window.eventTracker.track('item_view', { item_id: item.id, category_id: item.categoryId });
    } else {
      renderMissing();
    }

    if (!state.open) {
      state.open = true;
      lockScroll();
      if (!modal.open) modal.showModal();
    }
    bodyEl.scrollTop = 0;

    // История: первое открытие добавляет запись, чтобы "назад" закрывало карточку, а не уводило
    // со страницы; переход из карточки в карточку (лента "ещё из этой категории") эту же запись
    // заменяет — цепочка карточек не должна требовать десяти нажатий "назад".
    if (fromHistory) return;
    if (state.pushed) {
      window.history.replaceState({ dishCard: state.itemId }, '', itemUrl(state.itemId));
    } else {
      window.history.pushState({ dishCard: state.itemId }, '', itemUrl(state.itemId));
      state.pushed = true;
    }
  }

  // Единственная точка закрытия: возврат прокрутки, сброс состояния и снятие записи истории.
  // Идемпотентна — её дёргают и наши обработчики (кнопка, свайп, добавление в корзину), и
  // событие close нативного диалога (Escape, клик по затемнению в modal.js). Полагаться только
  // на close нельзя: не во всех webview он приходит, а прокрутка фона осталась бы заблокированной.
  function closeCard(fromHistory) {
    if (!state.open) return;
    state.open = false;
    if (modal.open) modal.close();
    unlockScroll();
    if (shareBtn) shareBtn.hidden = false;
    if (copiedNote) copiedNote.hidden = true;
    state.itemId = null;
    // Иначе в адресе осталось бы ?item= уже закрытой карточки, а "назад" открывало бы её заново.
    if (state.pushed && !fromHistory) {
      state.pushed = false;
      window.history.back();
    }
  }

  modal.addEventListener('close', function () { closeCard(false); });

  // Escape и клик по затемнению закрывают нативный диалог сами; ловим их явно, чтобы закрытие
  // прошло через closeCard даже там, где события close не будет.
  modal.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCard(false);
    }
  });
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeCard(false);
  });

  window.addEventListener('popstate', function (e) {
    var target = e.state && e.state.dishCard;
    state.pushed = Boolean(target);
    if (target) open(target, true);
    else closeCard(true);
  });

  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-dish-open]');
    if (opener) {
      e.preventDefault();
      open(Number(opener.dataset.dishOpen), false);
      return;
    }
    if (e.target.closest('[data-dish-close]')) {
      e.preventDefault();
      closeCard(false);
    }
  });

  var closeBtn = document.getElementById('dishCardClose');
  if (closeBtn) closeBtn.addEventListener('click', function () { closeCard(false); });

  // Пересчёт цены и доступности кнопки при выборе опций внутри карточки.
  bodyEl.addEventListener('change', function (e) {
    if (!e.target.classList || !e.target.classList.contains('option-choice-input')) return;
    var item = api.getItem(state.itemId);
    if (item) api.refreshSelectionState(bodyEl, item, submitBtn);
  });

  submitBtn.addEventListener('click', function () {
    var item = api.getItem(state.itemId);
    if (!item) return;
    var selectedIds = api.selectedIdsIn(bodyEl);
    if (!api.isSelectionValid(item, selectedIds)) return;
    api.addToCart(item, selectedIds);
    closeCard(false);
  });

  if (shareBtn) {
    shareBtn.addEventListener('click', function () {
      var url = state.itemId ? itemUrl(state.itemId) : window.location.href;
      var item = api.getItem(state.itemId);
      var title = item ? item.name : document.title;
      if (navigator.share) {
        navigator.share({ title: title, url: url }).catch(function () {});
        return;
      }
      var showCopied = function () {
        if (!copiedNote) return;
        copiedNote.hidden = false;
        setTimeout(function () { copiedNote.hidden = true; }, 2000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(showCopied).catch(function () {});
      }
    });
  }

  // Свайп вниз закрывает карточку на мобильном (на десктопе жест просто не случается).
  var touchStartY = null;
  modal.addEventListener('touchstart', function (e) {
    touchStartY = e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  modal.addEventListener('touchend', function (e) {
    if (touchStartY === null) return;
    var endY = e.changedTouches[0].clientY;
    if (endY - touchStartY > 70 && bodyEl.scrollTop <= 0) closeCard(false);
    touchStartY = null;
  });

  // Прямая ссылка /menu/:slug?item=<id>: карточка открывается сразу, а фон — обычное меню,
  // проскролленное к этой позиции (позиции может уже не быть — тогда карточка с пометкой).
  // Текущую запись истории подменяем на адрес меню без ?item= и уже поверх неё открываем
  // карточку: тогда "назад" закрывает карточку и оставляет гостя в меню, а не уводит с сайта.
  if (DATA.initialItemId) {
    var opener = document.querySelector('[data-dish-open="' + DATA.initialItemId + '"]');
    var row = opener && opener.closest('.dish-row');
    if (row) row.scrollIntoView({ block: 'center' });

    var plainUrl = new URL(window.location.href);
    plainUrl.searchParams.delete('item');
    window.history.replaceState({}, '', plainUrl.toString());
    open(DATA.initialItemId, false);
  }
})();
