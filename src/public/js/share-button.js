(function () {
  // Промт 4.2. Раньше эта логика жила инлайновым <script> сразу в двух шаблонах (дашборд
  // и публичное меню) — почти одинаковая, но с мелкими расхождениями. Вынесена в файл
  // не только ради CSP: два места с одним и тем же кодом рано или поздно расходятся, и одно
  // из них ломается молча.
  //
  // Разметка: кнопка с data-share-button, необязательные data-share-url (иначе берётся
  // текущий адрес) и data-share-note (id элемента «скопировано»).
  document.addEventListener('click', function (event) {
    var btn = event.target.closest ? event.target.closest('[data-share-button]') : null;
    if (!btn) return;

    var raw = btn.getAttribute('data-share-url');
    var url = raw ? window.location.origin + raw : window.location.href;
    var note = btn.getAttribute('data-share-note')
      ? document.getElementById(btn.getAttribute('data-share-note'))
      : null;

    // Событие аналитики шлёт только публичная страница меню — на дашборде eventTracker
    // не подключён, и проверка на его наличие заменяет отдельную ветку на каждый шаблон.
    if (window.eventTracker) window.eventTracker.track('share');

    // Системное «поделиться» доступно почти везде на телефонах и почти нигде на десктопе —
    // поэтому копирование в буфер это не запасной путь «на всякий случай», а основной
    // сценарий для половины пользователей.
    if (navigator.share) {
      navigator.share({ title: document.title, url: url }).catch(function () {});
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        if (!note) return;
        note.hidden = false;
        window.setTimeout(function () { note.hidden = true; }, 2000);
      }).catch(function () {});
    }
  });
}());
