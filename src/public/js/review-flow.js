(function () {
  // Сбор отзывов у гостя (промт 3.3). В кэшируемый HTML попадает только «сбор включён
  // у заведения»; всё остальное — задержка, порог, ссылки на карты и главное «не оставлял ли
  // этот гость отзыв за последние 30 дней» — приходит из /review/:slug/context, который
  // отвечает с Cache-Control: no-store.
  var prompt = document.getElementById('reviewPrompt');
  var modal = document.getElementById('review-modal');
  var dataEl = document.getElementById('menuData');
  if (!prompt || !modal || !dataEl) return;

  var DATA = JSON.parse(dataEl.textContent);
  var L = DATA.labels;
  var SLUG = DATA.slug;
  var BASE = '/review/' + encodeURIComponent(SLUG);

  // localStorage — вторая линия, а не единственная: она мгновенно закрывает приглашение
  // в этой же вкладке, но сервер всё равно проверяет 30 дней сам (её чистят в один клик).
  var STORAGE_KEY = 'review_done_' + SLUG;
  var DISMISS_KEY = 'review_hidden_' + SLUG;
  var DISMISS_MS = 24 * 60 * 60 * 1000;

  var titleEl = document.getElementById('reviewModalTitle');
  var bodyEl = document.getElementById('reviewBody');
  var errorEl = document.getElementById('reviewError');
  var chosenStarsEl = document.getElementById('reviewChosenStars');
  var changeBtn = document.getElementById('reviewChangeBtn');
  var commentLabelEl = document.getElementById('reviewCommentLabel');
  var commentEl = document.getElementById('reviewComment');
  var contactEl = document.getElementById('reviewContact');
  var submitBtn = document.getElementById('reviewSubmitBtn');
  var thanksEl = document.getElementById('reviewThanks');
  var mapsEl = document.getElementById('reviewMaps');
  var mapsHintEl = document.getElementById('reviewMapsHint');
  var googleLink = document.getElementById('reviewGoogleLink');
  var yandexLink = document.getElementById('reviewYandexLink');
  var dismissBtn = document.getElementById('reviewPromptDismiss');
  var starInputs = Array.prototype.slice.call(prompt.querySelectorAll('.review-star-input'));

  var context = null;
  var rating = 0;
  var reviewId = null;
  var submitted = false;

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* приватный режим/переполнение — приглашение просто покажется ещё раз, это не ошибка */
    }
  }

  function alreadyDone() {
    return readStorage(STORAGE_KEY) !== null;
  }

  // «Закрыл крестиком» — прячем на сутки, а не навсегда: гость мог закрыть случайно, но
  // возвращать карточку на каждое обновление страницы навязчиво.
  function dismissedRecently() {
    var raw = readStorage(DISMISS_KEY);
    if (!raw) return false;
    var at = Number(raw);
    return !!at && Date.now() - at < DISMISS_MS;
  }

  function showPrompt() {
    prompt.hidden = false;
    // Класс, а не hidden -> анимация появления и учёт prefers-reduced-motion живут в CSS.
    window.requestAnimationFrame(function () { prompt.classList.add('is-visible'); });
  }

  function hidePrompt() {
    prompt.classList.remove('is-visible');
    prompt.hidden = true;
  }

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function renderChosenStars() {
    chosenStarsEl.innerHTML = '';
    for (var i = 1; i <= 5; i++) {
      var span = document.createElement('span');
      span.className = 'review-chosen-star' + (i <= rating ? ' filled' : '');
      span.textContent = '★';
      chosenStarsEl.appendChild(span);
    }
    chosenStarsEl.setAttribute('aria-label', L.reviewStarAria.replace('__STAR__', String(rating)));
  }

  function applyMapLinks() {
    var hasGoogle = !!(context && context.googleUrl);
    var hasYandex = !!(context && context.yandexUrl);
    if (hasGoogle) googleLink.href = context.googleUrl;
    if (hasYandex) yandexLink.href = context.yandexUrl;
    googleLink.hidden = !hasGoogle;
    yandexLink.hidden = !hasYandex;
    // Ссылки не заполнены — блок не показываем вовсе, без пустых кнопок (edge case промта).
    mapsEl.hidden = !hasGoogle && !hasYandex;
  }

  // Ветка выбирается ровно по порогу заведения. Отличается только акцент и порядок блоков —
  // сами кнопки публичного отзыва видны в обеих (это требование промта, а не оформление).
  function applyBranch() {
    var isHigh = rating >= (context ? context.threshold : 4);
    bodyEl.classList.toggle('is-high', isHigh);
    bodyEl.classList.toggle('is-low', !isHigh);
    titleEl.textContent = isHigh ? L.reviewTitleHigh : L.reviewTitleLow;
    commentLabelEl.textContent = isHigh ? L.reviewCommentHigh : L.reviewCommentLow;
    commentEl.placeholder = isHigh ? L.reviewCommentPlaceholderHigh : L.reviewCommentPlaceholderLow;
    mapsHintEl.textContent = isHigh ? L.reviewMapsHintHigh : L.reviewMapsHintLow;
    submitBtn.textContent = isHigh ? L.reviewSubmitHigh : L.reviewSubmitLow;
    mapsEl.classList.toggle('is-primary', isHigh);
    mapsEl.classList.toggle('is-secondary', !isHigh);
    renderChosenStars();
    applyMapLinks();
  }

  function markSubmitted(hasContact) {
    submitted = true;
    if (window.eventTracker) window.eventTracker.track('review_submit', { value: rating });
    writeStorage(STORAGE_KEY, String(Date.now()));
    submitBtn.hidden = true;
    commentEl.disabled = true;
    contactEl.disabled = true;
    changeBtn.hidden = true;
    thanksEl.textContent = hasContact ? L.reviewThanksContact : L.reviewThanks;
    thanksEl.hidden = false;
  }

  function payload(external) {
    var body = { rating: rating, comment: commentEl.value.trim(), contact: contactEl.value.trim() };
    if (external) body.external = external;
    return JSON.stringify(body);
  }

  function submitReview() {
    if (submitted) return;
    showError('');
    submitBtn.disabled = true;
    fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload(null),
    })
      .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
      .then(function (res) {
        submitBtn.disabled = false;
        if (res.status === 201) {
          reviewId = res.data.reviewId;
          markSubmitted(res.data.hasContact);
          return;
        }
        // Отзыв за эти 30 дней уже есть — это не ошибка гостя: показываем ту же благодарность
        // и оставляем кнопки карт, публично написать он по-прежнему вправе.
        if (res.status === 409) {
          markSubmitted(false);
          thanksEl.textContent = L.reviewAlready;
          return;
        }
        showError(L.reviewGenericError);
      })
      .catch(function () {
        submitBtn.disabled = false;
        showError(L.reviewGenericError);
      });
  }

  // Гость уходит по ссылке на карты. Ждать ответа сервера нельзя — браузер уже открывает
  // вкладку, поэтому пишем через sendBeacon (тот же приём, что в event-tracker.js): если
  // отзыв ещё не отправлен, он создаётся этим же запросом вместе с отметкой о переходе,
  // если уже отправлен — проставляется только отметка.
  function beacon(url, body) {
    if (navigator.sendBeacon) {
      var blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return;
    }
    if (window.fetch) {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
        .catch(function () {});
    }
  }

  function handleMapClick(target) {
    if (submitted && reviewId) {
      beacon(BASE + '/external', JSON.stringify({ reviewId: reviewId, target: target }));
      return;
    }
    if (!submitted) {
      beacon(BASE, payload(target));
      markSubmitted(!!contactEl.value.trim());
    }
  }

  function openModal(value) {
    rating = value;
    reviewId = null;
    submitted = false;
    showError('');
    thanksEl.hidden = true;
    submitBtn.hidden = false;
    submitBtn.disabled = false;
    changeBtn.hidden = false;
    commentEl.disabled = false;
    contactEl.disabled = false;
    applyBranch();
    hidePrompt();
    modal.showModal();

  }

  starInputs.forEach(function (input) {
    input.addEventListener('change', function () {
      if (input.checked) openModal(Number(input.value));
    });
  });

  // «Изменить оценку» возвращает к звёздам в самой карточке — отдельного набора звёзд внутри
  // модалки нет намеренно: два независимых набора radio с одним именем разошлись бы по
  // состоянию, а один источник истины проще и для скринридера.
  changeBtn.addEventListener('click', function () {
    modal.close();
    starInputs.forEach(function (input) { input.checked = false; });
    showPrompt();
  });

  submitBtn.addEventListener('click', submitReview);

  googleLink.addEventListener('click', function () { handleMapClick('google'); });
  yandexLink.addEventListener('click', function () { handleMapClick('yandex'); });

  dismissBtn.addEventListener('click', function () {
    writeStorage(DISMISS_KEY, String(Date.now()));
    hidePrompt();
  });

  // Промт: приглашение показывается не раньше reviews_prompt_delay_sec на странице ИЛИ сразу
  // после отправки заказа. Второй случай — событие от order-flow.js, оно отменяет ожидание.
  var timer = null;
  var orderSent = false;

  function schedulePrompt(delayMs) {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      if (alreadyDone() || dismissedRecently()) return;
      // Карточка приглашения живёт в обычном потоке страницы и под открытым <dialog>
      // (подтверждение заказа, карточка блюда) её попросту не видно — ждём, пока гость
      // закроет то, что открыл, вместо того чтобы показать приглашение «в никуда».
      if (document.querySelector('dialog[open]')) {
        schedulePrompt(1500);
        return;
      }
      showPrompt();
      // Типы событий — из общего списка промта 3.2 (CLIENT_EVENT_TYPES): 'review_prompt' —
      // приглашение показано, 'review_submit' — отзыв отправлен, оценка едет в value.
      if (window.eventTracker) window.eventTracker.track('review_prompt');
    }, delayMs);
  }

  // Заказ отправлен — приглашение показываем сразу, не дожидаясь reviews_prompt_delay_sec.
  // Флаг нужен на случай, если заказ ушёл раньше, чем вернулся /context.
  document.addEventListener('qrmenu:order-sent', function () {
    orderSent = true;
    if (!context || !context.available || context.alreadyReviewed || alreadyDone()) return;
    schedulePrompt(1500);
  });

  if (alreadyDone() || dismissedRecently()) return;

  fetch(BASE + '/context', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      context = data;
      if (!data || !data.available) return;
      if (data.alreadyReviewed) {
        // Сервер знает про отзыв, которого нет в этом браузере (другая вкладка, чистый
        // localStorage) — запоминаем, чтобы больше не ходить за контекстом на каждой странице.
        writeStorage(STORAGE_KEY, String(Date.now()));
        return;
      }
      schedulePrompt(orderSent ? 1500 : Math.max(0, Number(data.delaySec) || 0) * 1000);
    })
    .catch(function () {});
}());
