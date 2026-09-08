(function () {
  // Промт 3.5. Экран стоп-листа в руках официанта: переключение без перезагрузки,
  // оптимистичное обновление, откат при ошибке и явная обработка потери сети.
  var labelsEl = document.getElementById('stoplistLabels');
  var list = document.getElementById('stoplistList');
  if (!labelsEl || !list) return;

  var L = JSON.parse(labelsEl.textContent);
  var banner = document.getElementById('stoplistBanner');
  var bannerText = document.getElementById('stoplistBannerText');
  var retryBtn = document.getElementById('stoplistRetry');
  var searchInput = document.getElementById('stoplistSearch');
  var onlyUnavailable = document.getElementById('stoplistOnlyUnavailable');
  var unavailableCountEl = document.getElementById('stoplistUnavailableCount');
  var restoreBtn = document.getElementById('stoplistRestoreAll');
  var emptyFilterNote = document.getElementById('stoplistEmptyFilter');

  // Последнее не сохранившееся действие — чтобы кнопка «Повторить» знала, что именно повторять.
  var pendingRetry = null;

  function showBanner(text, withRetry) {
    bannerText.textContent = text;
    retryBtn.hidden = !withRetry;
    banner.hidden = false;
  }

  function hideBanner() {
    banner.hidden = true;
    retryBtn.hidden = true;
    pendingRetry = null;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || { _csrf: L.csrf }),
    });
  }

  // ---- пересчёт счётчика и фильтра --------------------------------------------------------

  function recountUnavailable() {
    var items = list.querySelectorAll('[data-stoplist-row][data-available="0"]').length;
    var options = list.querySelectorAll('[data-option-row][data-available="0"]').length;
    unavailableCountEl.textContent = String(items + options);
  }

  function applyFilters() {
    var query = (searchInput.value || '').trim().toLowerCase();
    var onlyOff = onlyUnavailable.checked;
    var visible = 0;

    Array.prototype.forEach.call(list.querySelectorAll('[data-stoplist-row]'), function (row) {
      var matchesQuery = !query || row.dataset.search.indexOf(query) !== -1;
      // «Только недоступные» показывает и позицию, у которой выключен хотя бы один вариант:
      // с точки зрения официанта это тоже «что-то не в наличии».
      var hasOffOption = row.querySelector('[data-option-row][data-available="0"]') !== null;
      var matchesFilter = !onlyOff || row.dataset.available === '0' || hasOffOption;
      var show = matchesQuery && matchesFilter;
      row.hidden = !show;
      if (show) visible += 1;
    });

    emptyFilterNote.hidden = visible !== 0;
  }

  // ---- переключение -----------------------------------------------------------------------

  function setRowState(row, isAvailable) {
    row.dataset.available = isAvailable ? '1' : '0';
    var input = row.querySelector('[data-item-toggle]');
    if (input) input.checked = isAvailable;
  }

  function setOptionState(optionRow, isAvailable) {
    optionRow.dataset.available = isAvailable ? '1' : '0';
    var input = optionRow.querySelector('[data-option-toggle]');
    if (input) input.checked = isAvailable;
  }

  function noteFor(row, name, date) {
    var note = row.querySelector('[data-note]');
    if (!note) return;
    if (!name) {
      note.textContent = '';
      return;
    }
    var time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    note.textContent = L.turnedOffBy.replace('__NAME__', name).replace('__TIME__', time);
  }

  function handleFailure(err, rollback) {
    rollback();
    // Оффлайн и «сервер ответил ошибкой» — разные новости. При потере сети действие имеет
    // смысл повторить тем же тапом, поэтому показываем кнопку «Повторить»; при ответе
    // сервера повтор, скорее всего, даст тот же результат.
    var offline = !navigator.onLine || (err && err.name === 'TypeError');
    showBanner(offline ? L.offline : L.failed, offline);
  }

  function toggleItem(row, input) {
    var id = row.dataset.itemId;
    var before = row.dataset.available === '1';
    var optimistic = input.checked;

    hideBanner();
    setRowState(row, optimistic);
    recountUnavailable();

    var attempt = function () {
      return post('/admin/stoplist/items/' + encodeURIComponent(id) + '/toggle')
        .then(function (r) {
          if (r.status === 404) throw new Error('gone');
          if (!r.ok) throw new Error('failed');
          return r.json();
        })
        .then(function (data) {
          // Рисуем то, что ВЕРНУЛ сервер, а не свою догадку: если ту же позицию только что
          // переключил второй официант, интерфейс подтянет фактическое состояние без ошибки.
          setRowState(row, data.isAvailable);
          noteFor(row, data.isAvailable ? null : data.by, new Date());
          recountUnavailable();
          applyFilters();
          hideBanner();
        })
        .catch(function (err) {
          if (err && err.message === 'gone') {
            setRowState(row, before);
            recountUnavailable();
            showBanner(L.notFound, false);
            return;
          }
          handleFailure(err, function () {
            setRowState(row, before);
            recountUnavailable();
          });
          pendingRetry = attempt;
        });
    };

    attempt();
  }

  function toggleOption(optionRow, input) {
    var id = optionRow.dataset.optionId;
    var before = optionRow.dataset.available === '1';

    hideBanner();
    setOptionState(optionRow, input.checked);
    recountUnavailable();

    var attempt = function () {
      return post('/admin/stoplist/options/' + encodeURIComponent(id) + '/toggle')
        .then(function (r) {
          if (r.status === 404) throw new Error('gone');
          if (!r.ok) throw new Error('failed');
          return r.json();
        })
        .then(function (data) {
          setOptionState(optionRow, data.isAvailable);
          recountUnavailable();
          applyFilters();
          hideBanner();
        })
        .catch(function (err) {
          if (err && err.message === 'gone') {
            setOptionState(optionRow, before);
            recountUnavailable();
            showBanner(L.notFound, false);
            return;
          }
          handleFailure(err, function () {
            setOptionState(optionRow, before);
            recountUnavailable();
          });
          pendingRetry = attempt;
        });
    };

    attempt();
  }

  list.addEventListener('change', function (event) {
    var input = event.target;
    if (input.hasAttribute && input.hasAttribute('data-item-toggle')) {
      toggleItem(input.closest('[data-stoplist-row]'), input);
      return;
    }
    if (input.hasAttribute && input.hasAttribute('data-option-toggle')) {
      toggleOption(input.closest('[data-option-row]'), input);
    }
  });

  retryBtn.addEventListener('click', function () {
    if (!pendingRetry) return;
    var retry = pendingRetry;
    pendingRetry = null;
    hideBanner();
    retry();
  });

  // ---- «вернуть всё в наличие» ------------------------------------------------------------

  restoreBtn.addEventListener('click', function () {
    if (!window.confirm(restoreBtn.dataset.confirmText)) return;
    restoreBtn.disabled = true;
    hideBanner();

    post('/admin/stoplist/restore-all')
      .then(function (r) {
        if (!r.ok) throw new Error('failed');
        return r.json();
      })
      .then(function () {
        Array.prototype.forEach.call(list.querySelectorAll('[data-stoplist-row]'), function (row) {
          setRowState(row, true);
          noteFor(row, null);
        });
        Array.prototype.forEach.call(list.querySelectorAll('[data-option-row]'), function (optionRow) {
          setOptionState(optionRow, true);
        });
        recountUnavailable();
        applyFilters();
        showBanner(L.restoreDone, false);
      })
      .catch(function (err) {
        handleFailure(err, function () {});
      })
      .finally(function () {
        restoreBtn.disabled = false;
      });
  });

  // ---- сверка состояния -------------------------------------------------------------------

  // Телефон официанта лежит в кармане, вкладка висит открытой часами. При возврате на передний
  // план (и при восстановлении сети) забираем актуальные состояния с сервера: иначе он увидит
  // картину получасовой давности и решит, что позиция ещё в наличии.
  function refreshStates() {
    return fetch('/admin/stoplist/state', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        data.items.forEach(function (state) {
          var row = list.querySelector('[data-stoplist-row][data-item-id="' + state.id + '"]');
          if (row) setRowState(row, state.isAvailable);
        });
        data.options.forEach(function (state) {
          var optionRow = list.querySelector('[data-option-row][data-option-id="' + state.id + '"]');
          if (optionRow) setOptionState(optionRow, state.isAvailable);
        });
        recountUnavailable();
        applyFilters();
      })
      .catch(function () {});
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshStates();
  });
  window.addEventListener('online', function () {
    hideBanner();
    refreshStates();
  });
  window.addEventListener('offline', function () {
    showBanner(L.offline, false);
  });

  searchInput.addEventListener('input', applyFilters);
  onlyUnavailable.addEventListener('change', applyFilters);
  applyFilters();
}());
