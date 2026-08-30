document.documentElement.classList.add('js-reveal');

(function () {
  // Ничего здесь не предполагает, что меню/тулбар обязательно есть на странице — если у
  // заведения пока нет ни одной категории, соответствующие querySelectorAll просто вернут
  // пустые списки, а карточка заведения (с её обложкой) отрендерится и оживёт как обычно.
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  var reduced = prefersReducedMotion();

  // --- появление позиций меню при скролле ----------------------------------------------
  // Карточка заведения и первая категория рендерятся без [data-reveal] (см. menu.ejs) —
  // видны сразу. Ниже первого экрана — тот же приём, что и на лендинге (общие CSS-правила
  // [data-reveal]/.is-revealed в design-system.css), но короче и резче через data-reveal-menu.
  var revealTargets = document.querySelectorAll('[data-reveal]');
  if (revealTargets.length > 0) {
    if (reduced || !('IntersectionObserver' in window)) {
      revealTargets.forEach(function (el) { el.classList.add('is-revealed'); });
    } else {
      var revealObserver = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          obs.unobserve(entry.target);
          var delay = entry.target.getAttribute('data-reveal-delay');
          if (delay) entry.target.style.transitionDelay = delay + 'ms';
          entry.target.classList.add('is-revealed');
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });
      revealTargets.forEach(function (el) { revealObserver.observe(el); });
    }
  }

  // --- сортировка внутри каждой категории -----------------------------------------------

  document.querySelectorAll('.dish-list').forEach(function (list) {
    Array.prototype.forEach.call(list.children, function (row, index) {
      row.dataset.orderIndex = index;
    });
  });

  function orderIndex(row) {
    return parseInt(row.dataset.orderIndex, 10) || 0;
  }

  function sortLists(sortValue) {
    document.querySelectorAll('.dish-list').forEach(function (list) {
      var rows = Array.prototype.slice.call(list.children);
      rows.sort(function (a, b) {
        if (sortValue === 'price-asc') return (parseFloat(a.dataset.price) - parseFloat(b.dataset.price)) || (orderIndex(a) - orderIndex(b));
        if (sortValue === 'price-desc') return (parseFloat(b.dataset.price) - parseFloat(a.dataset.price)) || (orderIndex(a) - orderIndex(b));
        if (sortValue === 'name') return a.dataset.name.localeCompare(b.dataset.name, 'ru');
        return orderIndex(a) - orderIndex(b);
      });
      rows.forEach(function (row) { list.appendChild(row); });
    });
  }

  document.querySelectorAll('.sort-option').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.sort-option').forEach(function (b) { b.classList.toggle('active', b === btn); });
      sortLists(btn.dataset.sortValue);
      var details = btn.closest('details');
      if (details) details.removeAttribute('open');
    });
  });

  // --- вкладки категорий: "Все" либо ровно одна категория, плюс живой поиск и фильтры --------

  var searchInput = document.getElementById('menuSearchInput');
  var availableOnlyCheckbox = document.getElementById('filterAvailableOnly');
  var priceMinInput = document.getElementById('filterPriceMin');
  var priceMaxInput = document.getElementById('filterPriceMax');
  var categoryNav = document.getElementById('categoryNav');
  var searchEmptyNote = document.getElementById('searchEmptyNote');
  var filterBadge = document.getElementById('filterBadge');

  var currentCategoryId = 'all';

  function readState() {
    var checkedTags = document.querySelectorAll('.filter-tag-checkbox:checked');
    return {
      query: searchInput ? searchInput.value.trim().toLowerCase() : '',
      availableOnly: !!(availableOnlyCheckbox && availableOnlyCheckbox.checked),
      priceMin: priceMinInput && priceMinInput.value !== '' ? parseFloat(priceMinInput.value) : null,
      priceMax: priceMaxInput && priceMaxInput.value !== '' ? parseFloat(priceMaxInput.value) : null,
      tags: Array.prototype.map.call(checkedTags, function (cb) { return cb.value; }),
    };
  }

  function isRowVisible(row, state) {
    if (state.query) {
      var haystack = row.dataset.name + ' ' + row.dataset.description;
      if (haystack.indexOf(state.query) === -1) return false;
    }
    if (state.availableOnly && row.dataset.available !== '1') return false;
    var price = parseFloat(row.dataset.price);
    if (state.priceMin !== null && price < state.priceMin) return false;
    if (state.priceMax !== null && price > state.priceMax) return false;
    if (state.tags.length > 0) {
      var rowTags = row.dataset.tags ? row.dataset.tags.split(',') : [];
      var matches = state.tags.some(function (tag) { return rowTags.indexOf(tag) !== -1; });
      if (!matches) return false;
    }
    return true;
  }

  // Строка, переставшая подходить под поиск/фильтр, коротко гаснет (opacity), а не пропадает
  // мгновенно — но появление обратно всегда мгновенное (без fade-in), иначе список будет
  // мельтешить при каждом введённом символе. Гонка (пользователь снова начал совпадать до
  // истечения таймера скрытия) гасится проверкой класса перед тем, как реально спрятать строку.
  function setRowState(row, visible) {
    if (visible) {
      row.classList.remove('is-filtering-out');
      row.hidden = false;
      return;
    }
    if (row.hidden) return;
    if (reduced) {
      row.hidden = true;
      return;
    }
    row.classList.add('is-filtering-out');
    window.setTimeout(function () {
      if (!row.classList.contains('is-filtering-out')) return;
      row.hidden = true;
      row.classList.remove('is-filtering-out');
    }, 180);
  }

  // Видимость строки блюда решают два независимых слоя: какая вкладка категории выбрана
  // (или поиск, который временно показывает совпадения из всех категорий сразу) и
  // фильтр/поиск внутри неё. Секция скрывается целиком, если она не входит в текущую
  // вкладку — так переключение категории не требует повторного похода за данными, всё уже
  // загружено на странице.
  function applyVisibility() {
    var state = readState();
    var searching = state.query.length > 0;
    var anyVisible = false;
    document.querySelectorAll('.menu-section').forEach(function (section) {
      var inScope = searching || currentCategoryId === 'all' || section.id === currentCategoryId;
      var sectionHasVisible = false;
      if (inScope) {
        section.querySelectorAll('.dish-row').forEach(function (row) {
          var visible = isRowVisible(row, state);
          setRowState(row, visible);
          if (visible) sectionHasVisible = true;
        });
      }
      section.hidden = !(inScope && sectionHasVisible);
      if (inScope && sectionHasVisible) anyVisible = true;
    });
    if (categoryNav) categoryNav.hidden = searching;
    if (searchEmptyNote) searchEmptyNote.hidden = anyVisible;
  }

  function updateFilterBadge() {
    if (!filterBadge) return;
    var active = (availableOnlyCheckbox && availableOnlyCheckbox.checked) ||
      (priceMinInput && priceMinInput.value !== '') ||
      (priceMaxInput && priceMaxInput.value !== '') ||
      document.querySelectorAll('.filter-tag-checkbox:checked').length > 0;
    filterBadge.hidden = !active;
  }

  if (searchInput) searchInput.addEventListener('input', applyVisibility);
  if (availableOnlyCheckbox) availableOnlyCheckbox.addEventListener('change', function () { applyVisibility(); updateFilterBadge(); });
  [priceMinInput, priceMaxInput].forEach(function (input) {
    if (input) input.addEventListener('input', function () { applyVisibility(); updateFilterBadge(); });
  });
  document.querySelectorAll('.filter-tag-checkbox').forEach(function (cb) {
    cb.addEventListener('change', function () { applyVisibility(); updateFilterBadge(); });
  });

  var filterResetBtn = document.getElementById('filterResetBtn');
  if (filterResetBtn) {
    filterResetBtn.addEventListener('click', function () {
      if (availableOnlyCheckbox) availableOnlyCheckbox.checked = false;
      if (priceMinInput) priceMinInput.value = '';
      if (priceMaxInput) priceMaxInput.value = '';
      document.querySelectorAll('.filter-tag-checkbox').forEach(function (cb) { cb.checked = false; });
      applyVisibility();
      updateFilterBadge();
    });
  }

  // --- лента категорий: стрелки прокрутки + переключение активной вкладки -------------------

  var categoryTrack = document.getElementById('categoryNavTrack');
  var arrowLeft = document.querySelector('.category-nav-arrow-left');
  var arrowRight = document.querySelector('.category-nav-arrow-right');

  if (categoryTrack && arrowLeft && arrowRight) {
    var updateArrows = function () {
      var overflow = categoryTrack.scrollWidth > categoryTrack.clientWidth + 1;
      arrowLeft.hidden = !overflow || categoryTrack.scrollLeft <= 1;
      arrowRight.hidden = !overflow || categoryTrack.scrollLeft + categoryTrack.clientWidth >= categoryTrack.scrollWidth - 1;
    };
    arrowLeft.addEventListener('click', function () {
      categoryTrack.scrollBy({ left: -160, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    });
    arrowRight.addEventListener('click', function () {
      categoryTrack.scrollBy({ left: 160, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    });
    categoryTrack.addEventListener('scroll', updateArrows, { passive: true });
    window.addEventListener('resize', updateArrows);
    updateArrows();
  }

  // Плавное появление свежепоказанной вкладки — короткая fade-анимация поверх уже видимого
  // состояния (display переключается мгновенно, анимировать его саму по себе нельзя).
  function playSectionEnterAnimation() {
    if (prefersReducedMotion()) return;
    document.querySelectorAll('.menu-section:not([hidden])').forEach(function (section) {
      section.classList.remove('section-fade-in');
      void section.offsetWidth;
      section.classList.add('section-fade-in');
    });
  }

  // Двигает только горизонтальную ленту чипсов (categoryTrack.scrollLeft), а не
  // Element.scrollIntoView() — тот заодно прокручивает и саму страницу вертикально по всем
  // скролл-предкам, а на телефоне с невысоким экраном лента категорий на первой загрузке
  // обычно ещё не в кадре (карточка заведения выше), так что вкладка "Все" незаметно для
  // пользователя утаскивала страницу вниз, пряча шапку.
  function centerChipInTrack(chip) {
    if (!categoryTrack) return;
    var target = chip.offsetLeft - (categoryTrack.clientWidth - chip.offsetWidth) / 2;
    target = Math.max(0, Math.min(target, categoryTrack.scrollWidth - categoryTrack.clientWidth));
    categoryTrack.scrollTo({ left: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  function setActiveCategory(id) {
    currentCategoryId = id;
    document.querySelectorAll('.category-chip').forEach(function (chip) {
      chip.classList.toggle('active', chip.dataset.categoryChip === id);
    });
    var activeChip = document.querySelector('.category-chip[data-category-chip="' + id + '"]');
    if (activeChip) centerChipInTrack(activeChip);
    applyVisibility();
    playSectionEnterAnimation();
  }

  document.querySelectorAll('.category-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      if (chip.dataset.categoryChip === currentCategoryId) return;
      setActiveCategory(chip.dataset.categoryChip);
      // После смены вкладки уже скрытый контент выше могло не быть видно — возвращаем
      // пользователя к началу списка, чтобы он сразу увидел новую подборку блюд.
      if (categoryNav) categoryNav.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  });

  // Прямая ссылка /menu/:slug/:categoryId сразу открывает нужную вкладку (если такая
  // категория есть на странице), иначе — вкладку "Все".
  (function selectInitialCategory() {
    var match = window.location.pathname.match(/\/menu\/[^/]+\/([^/?#]+)/);
    var initialId = 'all';
    if (match && document.getElementById('category-' + match[1])) {
      initialId = 'category-' + match[1];
    }
    setActiveCategory(initialId);
  })();

  // --- статус часов работы (простой парсинг "ЧЧ:ММ–ЧЧ:ММ" из первой строки) -----------------

  document.querySelectorAll('[data-hours-row]').forEach(function (row) {
    var raw = row.dataset.hoursRaw || '';
    var match = raw.match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/);
    if (!match) return;
    var startMinutes = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    var endMinutes = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);
    if (startMinutes === endMinutes) return;
    var now = new Date();
    var nowMinutes = now.getHours() * 60 + now.getMinutes();
    var isOpen = startMinutes < endMinutes
      ? (nowMinutes >= startMinutes && nowMinutes < endMinutes)
      : (nowMinutes >= startMinutes || nowMinutes < endMinutes);
    var statusEl = row.querySelector(isOpen ? '.hours-status-open' : '.hours-status-closed');
    if (statusEl) statusEl.hidden = false;
  });

  // --- плавная загрузка фото: шиммер-заглушка, пока картинка не отрисовалась ----------------
  // Класс "loading" вешаем только здесь и сразу же гарантируем его снятие по load/error —
  // без JS (или если он не выполнился до этого места) контейнер остаётся в обычном виде,
  // картинка не рискует навсегда остаться прозрачной.
  document.querySelectorAll('.dish-row-media, .venue-card-cover').forEach(function (media) {
    var img = media.querySelector('img');
    if (!img || (img.complete && img.naturalWidth > 0)) return;
    media.classList.add('loading');
    var markLoaded = function () { media.classList.remove('loading'); };
    img.addEventListener('load', markLoaded);
    img.addEventListener('error', markLoaded);
  });

  // --- пульсация плавающей корзины при изменении содержимого ---------------------------------

  window.publicMenuPulseCart = function () {
    if (prefersReducedMotion()) return;
    var btn = document.getElementById('cartBarToggle');
    if (!btn) return;
    btn.classList.remove('pulse');
    void btn.offsetWidth;
    btn.classList.add('pulse');
  };

  // --- быстрая fade-смена числа на бейджике корзины при изменении count ---------------------

  window.publicMenuFlashBadge = function () {
    if (prefersReducedMotion()) return;
    var badge = document.getElementById('cartBarCount');
    if (!badge) return;
    badge.classList.remove('flash');
    void badge.offsetWidth;
    badge.classList.add('flash');
  };
})();
