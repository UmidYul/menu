(function () {
  // Отправка заказа и вызов официанта (промт 2.4). Состав корзины берётся из window.menuCart
  // (menu-cart.js), а всё, что зависит от стола, — из /order/:slug/context: в кэшируемый HTML
  // страницы номер стола не попадает, иначе вкладка гостя за столом 5 раздавала бы «стол 5»
  // всем остальным.
  var modal = document.getElementById('order-modal');
  var api = window.menuCart;
  if (!modal || !api) return;

  var DATA = api.data;
  var L = DATA.labels;
  var SLUG = DATA.slug;

  var confirmStep = document.getElementById('orderConfirmStep');
  var sentStep = document.getElementById('orderSentStep');
  var linesEl = document.getElementById('orderLines');
  var totalEl = document.getElementById('orderTotal');
  var errorEl = document.getElementById('orderError');
  var submitBtn = document.getElementById('orderSubmitBtn');
  var closeBtn = document.getElementById('orderCloseBtn');
  var tableKnownEl = document.getElementById('orderTableKnown');
  var tableNumberEl = document.getElementById('orderTableNumber');
  var tableInputWrap = document.getElementById('orderTableInput');
  var tableInput = document.getElementById('orderTableNumberInput');
  var commentEl = document.getElementById('orderComment');
  var titleEl = document.getElementById('orderModalTitle');

  var context = null;
  var statusTimer = null;
  var statusStopAt = 0;

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function fetchContext() {
    return fetch('/order/' + encodeURIComponent(SLUG) + '/context', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // Строки корзины в том же виде, в каком их считает menu-cart.js — сервер всё равно пересчитает
  // сумму сам, здесь это только показ гостю перед отправкой.
  function cartLines() {
    var cart = api.getCart();
    return Object.keys(cart).map(function (key) {
      var line = cart[key];
      return { itemId: line.itemId, qty: line.qty, optionIds: line.optionIds || [], name: line.name, price: line.price, optionsLabel: line.optionsLabel, currency: line.currency };
    });
  }

  function renderConfirm() {
    var lines = cartLines();
    linesEl.innerHTML = lines.map(function (line) {
      return '<div class="order-line">'
        + '<span class="order-line-name">' + escapeHtml(line.name)
        + (line.optionsLabel ? '<span class="order-line-options">' + escapeHtml(line.optionsLabel) + '</span>' : '')
        + '</span>'
        + '<span class="order-line-qty">× ' + line.qty + '</span>'
        + '<span class="order-line-total">' + api.formatPrice(line.price * line.qty) + ' ' + escapeHtml(line.currency) + '</span>'
        + '</div>';
    }).join('');

    var total = lines.reduce(function (sum, line) { return sum + line.price * line.qty; }, 0);
    totalEl.textContent = api.formatPrice(total) + ' ' + (lines[0] ? lines[0].currency : '');
    return total;
  }

  function applyContext() {
    var known = context && context.tableNumber;
    tableKnownEl.hidden = !known;
    tableInputWrap.hidden = !!known;
    if (known) tableNumberEl.textContent = context.tableNumber;
  }

  function openOrder() {
    showError('');
    if (titleEl) titleEl.textContent = L.orderConfirmHeading;
    confirmStep.hidden = false;
    sentStep.hidden = true;
    submitBtn.hidden = false;
    closeBtn.hidden = true;
    renderConfirm();
    applyContext();
    modal.showModal();
  }

  function statusLabel(status) {
    if (status === 'accepted') return L.orderStatusAccepted;
    if (status === 'done') return L.orderStatusDone;
    if (status === 'cancelled') return L.orderStatusCancelled;
    return L.orderStatusNew;
  }

  function renderStatus(status) {
    var dot = document.getElementById('orderStatusDot');
    var text = document.getElementById('orderStatusText');
    if (text) text.textContent = statusLabel(status);
    if (dot) dot.className = 'order-status-dot is-' + status;
  }

  // Промт 2.4: опрос раз в 10 секунд в течение 15 минут, потом останавливаемся — вкладку могли
  // просто оставить открытой на весь вечер, бесконечно дёргать сервер незачем.
  function startStatusPolling(token) {
    statusStopAt = Date.now() + 15 * 60 * 1000;
    if (statusTimer) window.clearInterval(statusTimer);
    statusTimer = window.setInterval(function () {
      if (Date.now() > statusStopAt) {
        window.clearInterval(statusTimer);
        statusTimer = null;
        return;
      }
      fetch('/order/' + encodeURIComponent(SLUG) + '/' + encodeURIComponent(token) + '/status')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          renderStatus(data.status);
          // Заказ сохранён, но до группы не доехал (бота удалили из группы) — гость должен
          // знать, что показать заказ официанту придётся самому (промт 2.4, edge case).
          var undelivered = document.getElementById('orderUndelivered');
          if (undelivered) undelivered.hidden = data.delivered !== false;
          if (data.status === 'done' || data.status === 'cancelled') {
            window.clearInterval(statusTimer);
            statusTimer = null;
          }
        })
        .catch(function () {});
    }, 10000);
  }

  function submitOrder() {
    var lines = cartLines();
    if (lines.length === 0) return;

    var total = lines.reduce(function (sum, line) { return sum + line.price * line.qty; }, 0);
    var payload = {
      items: lines.map(function (line) { return { itemId: line.itemId, qty: line.qty, optionIds: line.optionIds }; }),
      expectedTotal: total,
      comment: commentEl.value.trim() || undefined,
    };
    if (tableInputWrap.hidden === false) payload.tableNumber = tableInput.value.trim() || undefined;

    submitBtn.disabled = true;
    showError('');

    fetch('/order/' + encodeURIComponent(SLUG), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (json) { return { status: r.status, json: json }; }); })
      .then(function (res) {
        submitBtn.disabled = false;
        if (res.status === 201) {
          confirmStep.hidden = true;
          sentStep.hidden = false;
          if (titleEl) titleEl.textContent = L.orderSentHeading;
          submitBtn.hidden = true;
          closeBtn.hidden = false;
          document.getElementById('orderSentNumber').textContent = '№' + res.json.orderId;
          renderStatus('new');
          startStatusPolling(res.json.statusToken);
          api.clearCart();
          return;
        }
        // Меню/цены изменились — сервер вернул актуальную сумму. Показываем сообщение и
        // перерисовываем состав: гость должен увидеть новое состояние до повторной отправки.
        showError(res.json.message || L.orderGenericError);
        renderConfirm();
      })
      .catch(function () {
        submitBtn.disabled = false;
        showError(L.orderNetworkError);
      });
  }

  var startBtn = document.getElementById('orderStartBtn');
  if (startBtn) {
    startBtn.addEventListener('click', function () {
      var cartModal = document.getElementById('cart-modal');
      if (cartModal && cartModal.open) cartModal.close();
      openOrder();
    });
  }
  submitBtn.addEventListener('click', submitOrder);
  closeBtn.addEventListener('click', function () { modal.close(); });

  // --- вызов официанта -------------------------------------------------------------------

  var waiterModal = document.getElementById('waiter-modal');
  var waiterBtn = document.getElementById('waiterCallBtn');

  function callWaiter(callType) {
    var errorBox = document.getElementById('waiterError');
    var resultBox = document.getElementById('waiterResult');
    errorBox.hidden = true;
    resultBox.hidden = true;

    fetch('/order/' + encodeURIComponent(SLUG) + '/waiter-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callType: callType }),
    })
      .then(function (r) { return r.json().then(function (json) { return { status: r.status, json: json }; }); })
      .then(function (res) {
        if (res.status === 201) {
          resultBox.textContent = res.json.message;
          resultBox.hidden = false;
          document.getElementById('waiterOptions').hidden = true;
          return;
        }
        errorBox.textContent = res.json.message || L.orderGenericError;
        errorBox.hidden = false;
      })
      .catch(function () {
        errorBox.textContent = L.orderNetworkError;
        errorBox.hidden = false;
      });
  }

  if (waiterModal && waiterBtn) {
    waiterBtn.addEventListener('click', function () {
      document.getElementById('waiterOptions').hidden = false;
      document.getElementById('waiterResult').hidden = true;
      document.getElementById('waiterError').hidden = true;
      waiterModal.showModal();
    });
    waiterModal.querySelectorAll('.waiter-option').forEach(function (btn) {
      btn.addEventListener('click', function () { callWaiter(btn.dataset.callType); });
    });
  }

  // Контекст запрашивается один раз при загрузке: он решает, показывать ли кнопку вызова
  // официанта (нужен известный стол) и подставлять ли номер стола в форму заказа.
  fetchContext().then(function (data) {
    context = data;
    if (!data) return;
    applyContext();
    if (waiterBtn && data.tableNumber && data.ordersAvailable) waiterBtn.hidden = false;
  });
})();
