(function () {
  // Клиентский сборщик событий аналитики (промт 3.2). Копит события в памяти и отправляет
  // пачкой через navigator.sendBeacon — не чаще раза в 5 секунд и обязательно перед уходом
  // со страницы, чтобы не терять "хвост" сессии. page_view сюда не входит — он пишется
  // сервером (см. src/routes/publicMenu.js), этот файл его никогда не отправляет.
  var dataEl = document.getElementById('menuData');
  if (!dataEl) {
    window.eventTracker = { track: function () {} };
    return;
  }

  var slug = JSON.parse(dataEl.textContent).slug;
  var ENDPOINT = '/api/events/' + encodeURIComponent(slug);
  var FLUSH_INTERVAL_MS = 5000;
  var queue = [];

  function deviceClass() {
    var w = window.innerWidth;
    if (w <= 640) return 'mobile';
    if (w <= 1023) return 'tablet';
    return 'desktop';
  }

  // Оба поля считаем один раз и переиспользуем: viewport на публичной странице меню не меняет
  // класс устройства посреди сессии (а даже если повернуть телефон — не настолько принципиально
  // для аналитики, чтобы пересчитывать на каждое событие).
  var DEVICE = deviceClass();
  var LANG = document.documentElement.lang || null;

  function track(eventType, extra) {
    var event = { event_type: eventType, lang: LANG, device: DEVICE };
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        if (extra[key] !== undefined && extra[key] !== null) event[key] = extra[key];
      });
    }
    queue.push(event);
    // На вероятный уход со страницы (клик по внешней ссылке, "поделиться" и т.п.) не ждём
    // следующего пятисекундного тика — довод тот же, что и у flush по pagehide ниже.
    if (queue.length >= 20) flush();
  }

  function flush() {
    if (queue.length === 0) return;
    var payload = JSON.stringify({ events: queue });
    queue = [];
    if (navigator.sendBeacon) {
      var blob = new Blob([payload], { type: 'application/json' });
      var ok = navigator.sendBeacon(ENDPOINT, blob);
      if (ok) return;
    }
    // Фолбэк для окружений без sendBeacon (или если браузер отказал, например превышен лимит
    // на выгрузке) — keepalive переживает уход со страницы почти так же надёжно, без ответа
    // никто не ждёт (эндпоинт всегда отвечает 204, см. src/routes/apiEvents.js).
    if (window.fetch) {
      fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
    }
  }

  window.setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });

  window.eventTracker = { track: track };
})();
