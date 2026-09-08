(function () {
  // Промт 4.2. Здесь живут ВСЕ поведения, которые раньше были инлайновыми обработчиками
  // (onclick="...showModal()", onclick="this.closest('dialog').close()" и т.п.).
  //
  // Их вынос — не косметика: пока в разметке есть хоть один onclick, CSP обязана содержать
  // script-src-attr 'unsafe-inline', а это ровно та директива, которой пользуется XSS-пейлоад
  // после инъекции. Теперь атрибутов нет, и обе директивы можно затянуть до 'self'.
  //
  // Всё сделано делегированием от document: элементы появляются и внутри диалогов, и после
  // повторного рендера, и вешать слушатели на каждый по отдельности пришлось бы заново.

  function closest(target, selector) {
    return target && target.closest ? target.closest(selector) : null;
  }

  document.addEventListener('click', function (event) {
    // Открыть модалку: data-modal-open="id-диалога".
    var opener = closest(event.target, '[data-modal-open]');
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute('data-modal-open'));
      if (dialog && typeof dialog.showModal === 'function') {
        // Кнопка может стоять внутри раскрытого <details> (меню действий строки) — его надо
        // закрыть, иначе оно останется висеть под модалкой.
        var details = closest(opener, 'details[open]');
        if (details) details.removeAttribute('open');
        dialog.showModal();
      }
      return;
    }

    // Закрыть ближайшую модалку: data-modal-close (без значения).
    var closer = closest(event.target, '[data-modal-close]');
    if (closer) {
      var owner = closest(closer, 'dialog');
      if (owner) owner.close();
      return;
    }

    // Печать страницы: data-print.
    if (closest(event.target, '[data-print]')) window.print();
  });

  // Клик по подложке модалки закрывает её. Делегирование здесь не подходит: цель события —
  // сам <dialog>, и отличить «клик по фону» от «клика по содержимому» можно только сравнением
  // e.target с самим диалогом.
  document.querySelectorAll('dialog.modal').forEach(function (dialog) {
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
  });

  // Селект/радио, отправляющий свою форму при изменении: data-submit-on-change.
  document.addEventListener('change', function (event) {
    var control = event.target;
    if (!control || !control.hasAttribute || !control.hasAttribute('data-submit-on-change')) return;
    if (control.form) control.form.submit();
  });

  // Переключение видимости двух блоков-альтернатив (например, «период пресетом» против
  // «период вручную»): data-toggle-show="id" data-toggle-hide="id".
  document.addEventListener('change', function (event) {
    var control = event.target;
    if (!control || !control.hasAttribute) return;

    var toShow = control.getAttribute('data-toggle-show');
    var toHide = control.getAttribute('data-toggle-hide');
    if (!toShow && !toHide) return;

    if (toShow) {
      var shown = document.getElementById(toShow);
      if (shown) shown.hidden = false;
    }
    if (toHide) {
      var hidden = document.getElementById(toHide);
      if (hidden) hidden.hidden = true;
    }
  });

  // Диалог, который надо открыть сразу при загрузке страницы: data-autoopen на самом <dialog>.
  // Раньше это делал инлайновый <script>document.getElementById('...').showModal()</script>
  // после ошибки валидации — теперь признак живёт в разметке, а решение об открытии в коде.
  document.querySelectorAll('dialog[data-autoopen]').forEach(function (dialog) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
  });
}());
