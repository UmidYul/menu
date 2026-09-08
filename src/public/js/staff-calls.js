(function () {
  // Промт 3.5. Экран вызовов официанта: подтверждение без перезагрузки и автоподхват новых
  // вызовов — телефон лежит в зале, и гость, нажавший «позовите официанта», не должен ждать,
  // пока кто-то обновит страницу.
  var labelsEl = document.getElementById('callsLabels');
  var list = document.getElementById('callsList');
  if (!labelsEl || !list) return;

  var L = JSON.parse(labelsEl.textContent);
  var banner = document.getElementById('callsBanner');
  var bannerText = document.getElementById('callsBannerText');
  var emptyNote = document.getElementById('callsEmpty');

  var POLL_INTERVAL_MS = 15000;
  var timer = null;

  function showBanner(text) {
    bannerText.textContent = text;
    banner.hidden = false;
  }

  function hideBanner() {
    banner.hidden = true;
  }

  function markAcked(row, name) {
    row.dataset.status = 'acknowledged';
    row.className = 'call-row is-acknowledged';
    var side = row.querySelector('.call-row-side');
    if (!side) return;
    var label = document.createElement('span');
    label.className = 'call-row-ack';
    label.textContent = name ? L.ackedBy.replace('__NAME__', name) : L.acked;
    side.innerHTML = '';
    side.appendChild(label);
  }

  list.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-call-ack]') : null;
    if (!button) return;

    var row = button.closest('[data-call-row]');
    button.disabled = true;
    hideBanner();

    fetch('/admin/calls/' + encodeURIComponent(button.dataset.callAck) + '/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _csrf: L.csrf }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('failed');
        return r.json();
      })
      .then(function (data) {
        // Вызов мог уже принять кто-то в Telegram-группе или на другом телефоне — это не
        // ошибка, просто перерисовываем строку как принятую.
        if (data.already) {
          markAcked(row, null);
          showBanner(L.alreadyAcked);
          return;
        }
        markAcked(row, data.acknowledgedByName);
      })
      .catch(function (err) {
        button.disabled = false;
        showBanner(!navigator.onLine || (err && err.name === 'TypeError') ? L.offline : L.failed);
      });
  });

  // Новые вызовы подтягиваются опросом: постоянного соединения ради одного экрана в зале
  // заводить незачем, а 15 секунд — незаметная для гостя задержка.
  function poll() {
    if (document.visibilityState !== 'visible') return;
    fetch('/admin/calls/state', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        render(data.calls);
      })
      .catch(function () {});
  }

  function callRowHtml(call) {
    var div = document.createElement('article');
    div.className = 'call-row is-' + call.status;
    div.setAttribute('data-call-row', '');
    div.dataset.callId = String(call.id);
    div.dataset.status = call.status;

    var main = document.createElement('div');
    main.className = 'call-row-main';
    var table = document.createElement('b');
    table.className = 'call-row-table';
    table.textContent = call.tableNumber
      ? L.tableLabel.replace('__TABLE__', String(call.tableNumber))
      : L.noTable;
    var type = document.createElement('span');
    type.className = 'call-row-type';
    type.textContent = L.callTypes[call.callType] || call.callType;
    var time = document.createElement('span');
    time.className = 'call-row-time';
    time.textContent = String(call.createdAt).slice(11, 16);
    main.appendChild(table);
    main.appendChild(type);
    main.appendChild(time);

    var side = document.createElement('div');
    side.className = 'call-row-side';
    if (call.status === 'new') {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-primary call-ack-btn';
      button.setAttribute('data-call-ack', String(call.id));
      button.textContent = L.ackButton;
      side.appendChild(button);
    } else {
      var label = document.createElement('span');
      label.className = 'call-row-ack';
      label.textContent = call.acknowledgedByName ? L.ackedBy.replace('__NAME__', call.acknowledgedByName) : L.acked;
      side.appendChild(label);
    }

    div.appendChild(main);
    div.appendChild(side);
    return div;
  }

  // Дорисовываем только НОВЫЕ вызовы и обновляем статус существующих. Полная перерисовка
  // списка сбрасывала бы фокус и подсветку прямо под пальцем официанта.
  function render(calls) {
    calls.forEach(function (call) {
      var existing = list.querySelector('[data-call-row][data-call-id="' + call.id + '"]');
      if (!existing) {
        list.insertBefore(callRowHtml(call), list.firstChild);
        return;
      }
      if (existing.dataset.status !== call.status && call.status === 'acknowledged') {
        markAcked(existing, call.acknowledgedByName);
      }
    });
    if (emptyNote) emptyNote.hidden = calls.length > 0;
  }

  timer = window.setInterval(poll, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') poll();
  });
  window.addEventListener('pagehide', function () {
    if (timer) window.clearInterval(timer);
  });
}());
