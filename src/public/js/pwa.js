(function () {
  // Промт 2.5. Клиентская половина PWA: регистрация воркера, полоса «показано сохранённое меню»,
  // мягкое обновление воркера и ненавязчивое предложение установки.
  //
  // Регистрируется ТОЛЬКО на страницах меню — этот файл подключён только в public/menu.ejs.
  var dataEl = document.getElementById('pwaData');
  if (!dataEl) return;

  var DATA = JSON.parse(dataEl.textContent);
  var SLUG = DATA.slug;
  var L = DATA.labels;

  // iOS Safari не даёт beforeinstallprompt вовсе — там установка руками, через «Поделиться».
  // Определяется ЗДЕСЬ, а не на сервере: страница меню кэшируется по slug+lang, и признак,
  // вычисленный из User-Agent первого зашедшего, показывался бы всем остальным.
  // iPadOS с некоторых версий представляется как Macintosh — ловим его по наличию тач-точек.
  function isIosDevice() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return true;
    return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  }

  var VISITS_KEY = 'pwa_visits_' + SLUG;
  var PROMPT_KEY = 'pwa_prompt_at_' + SLUG;
  var DISMISS_KEY = 'pwa_dismissed_at_' + SLUG;
  var PROMPT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
  var MIN_VISITS = 2;
  var MIN_TIME_ON_PAGE_MS = 20000;

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
      /* приватный режим — предложение просто появится в следующий раз */
    }
  }

  // ---- полоса состояния --------------------------------------------------------------------

  var bar = document.getElementById('pwaBar');
  var barText = document.getElementById('pwaBarText');
  var barAction = document.getElementById('pwaBarAction');
  var barClose = document.getElementById('pwaBarClose');
  var barAccept = null;
  // Что именно сейчас показано: 'stale' | 'update' | 'install'. Нужно, чтобы отличить
  // «закрыл полосу про сохранённое меню» (просто закрыл) от «закрыл предложение установки»
  // (это отказ, и он запоминается на 30 дней).
  var barKind = null;

  function showBar(kind, text, actionLabel, onAction) {
    if (!bar) return;
    barKind = kind;
    barText.textContent = text;
    barAccept = onAction || null;
    barAction.hidden = !actionLabel;
    if (actionLabel) barAction.textContent = actionLabel;
    bar.hidden = false;
  }

  function hideBar() {
    if (!bar) return;
    bar.hidden = true;
    barAccept = null;
    barKind = null;
  }

  if (barAction) {
    barAction.addEventListener('click', function () {
      var action = barAccept;
      hideBar();
      if (action) action();
    });
  }

  // ---- service worker ----------------------------------------------------------------------

  function sendConfig(worker) {
    if (!worker) return;
    worker.postMessage({ type: 'CONFIG', slug: SLUG, menuVersion: String(DATA.menuVersion) });
  }

  // Своих заголовков страница о себе прочитать не может, а navigator.onLine врёт (телефон
  // в сети без интернета — обычное дело в зале). Спрашиваем воркер напрямую.
  function askStaleState() {
    if (!navigator.serviceWorker.controller || !window.MessageChannel) return;
    var channel = new MessageChannel();
    channel.port1.onmessage = function (event) {
      if (event.data && event.data.staleHtml) {
        showBar('stale', L.staleMenu, null, null);
      }
    };
    navigator.serviceWorker.controller.postMessage({ type: 'GET_STATE', slug: SLUG }, [channel.port2]);
  }

  // Промт: обновление воркера не должно требовать двойной перезагрузки — skipWaiting и
  // clients.claim, но СНАЧАЛА уведомляем открытые вкладки. Поэтому skipWaiting вызывает
  // не сам воркер при установке, а страница, когда гость нажал «Обновить».
  var reloading = false;
  function watchForUpdate(reg) {
    function offerUpdate(worker) {
      showBar('update', L.updateReady, L.updateAction, function () {
        worker.postMessage({ type: 'SKIP_WAITING' });
      });
    }

    if (reg.waiting) offerUpdate(reg.waiting);

    reg.addEventListener('updatefound', function () {
      var installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', function () {
        // controller есть — значит это ОБНОВЛЕНИЕ, а не первая установка: при первой
        // предлагать «обновить» бессмысленно, гость только что открыл страницу.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          offerUpdate(installing);
        }
      });
    });
  }

  function registerWorker() {
    // Приватный режим и браузеры без Cache API: страница обязана работать как обычно,
    // поэтому всё в try/catch и без единого await на пути первого рендера. Обращение к
    // navigator.serviceWorker тоже внутри проверки — в браузерах без поддержки его просто нет.
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        // Ровно одна перезагрузка на смену воркера — иначе при гонке вкладок можно уйти в цикл.
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });

      navigator.serviceWorker.register('/sw.js')
        .then(function (reg) {
          watchForUpdate(reg);
          sendConfig(reg.active || navigator.serviceWorker.controller);
          askStaleState();
        })
        .catch(function () {
          /* регистрация не удалась — просто живём без офлайна */
        });

      // controller появляется не сразу после первой установки; конфигурацию отправляем и тогда.
      navigator.serviceWorker.ready.then(function (reg) {
        sendConfig(reg.active);
      }).catch(function () {});
    } catch (err) {
      /* см. выше */
    }
  }

  // ---- предложение установки ----------------------------------------------------------------

  var deferredPrompt = null;

  function promptAllowed() {
    // Уже установлено — предлагать нечего.
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return false;
    if (window.navigator.standalone) return false;

    var dismissedAt = Number(readStorage(DISMISS_KEY));
    if (dismissedAt && Date.now() - dismissedAt < PROMPT_COOLDOWN_MS) return false;
    var shownAt = Number(readStorage(PROMPT_KEY));
    if (shownAt && Date.now() - shownAt < PROMPT_COOLDOWN_MS) return false;

    // Промт: только при втором визите. Первый визит — гость ещё не знает, нужен ли ему этот
    // ресторан на домашнем экране.
    var visits = Number(readStorage(VISITS_KEY)) || 0;
    return visits >= MIN_VISITS;
  }

  function rememberDismiss() {
    writeStorage(DISMISS_KEY, String(Date.now()));
  }

  if (barClose) {
    barClose.addEventListener('click', function () {
      // Крестик на предложении установки — это отказ, и он запоминается на 30 дней.
      // Крестик на полосе «показано сохранённое меню» — просто закрытие полосы.
      if (barKind === 'install') rememberDismiss();
      hideBar();
    });
  }

  function showInstallOffer() {
    if (!promptAllowed()) return;
    writeStorage(PROMPT_KEY, String(Date.now()));

    if (deferredPrompt) {
      showBar('install', L.installOffer, L.installAction, function () {
        var prompt = deferredPrompt;
        deferredPrompt = null;
        prompt.prompt();
        prompt.userChoice.then(function (choice) {
          if (choice && choice.outcome !== 'accepted') rememberDismiss();
        }).catch(function () {});
      });
      return;
    }

    // iOS Safari события beforeinstallprompt не даёт вовсе — там установка руками, через
    // «Поделиться». Показываем короткую инструкцию вместо кнопки, которая ничего не сделает.
    if (isIosDevice()) showBar('install', L.installIos, null, null);
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    // Свой момент показа важнее браузерного: промт требует не сразу, а на второй визит
    // и после 20 секунд на странице.
    event.preventDefault();
    deferredPrompt = event;
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    hideBar();
  });

  // ---- сеть ----------------------------------------------------------------------------------

  window.addEventListener('online', function () {
    // Промт: «при восстановлении сети полоса исчезает, содержимое молча обновляется, если
    // версия изменилась». Тихая проверка версии — обычный запрос к своей же странице; если
    // menu_version сменилась, перезагружаемся один раз.
    hideBar();
    fetch(window.location.href, { headers: { 'X-Requested-With': 'pwa-version-check' } })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (!html) return;
        var match = /"menuVersion":\s*"?(\d+)"?/.exec(html);
        if (match && match[1] !== String(DATA.menuVersion) && !reloading) {
          reloading = true;
          window.location.reload();
        }
      })
      .catch(function () {});
  });

  window.addEventListener('offline', function () {
    showBar('stale', L.staleMenu, null, null);
  });

  // ---- запуск ----------------------------------------------------------------------------------

  var visits = (Number(readStorage(VISITS_KEY)) || 0) + 1;
  writeStorage(VISITS_KEY, String(visits));

  registerWorker();
  window.setTimeout(showInstallOffer, MIN_TIME_ON_PAGE_MS);
}());
