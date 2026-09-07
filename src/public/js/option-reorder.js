(function () {
  // Перетаскивание вариантов внутри группы (промт 2.1). Кнопки "вверх/вниз" рядом делают то же
  // самое обычными формами — этот скрипт только добавляет удобство мышью, и если он не
  // выполнится (или устройство тач-only), порядок всё равно меняется кнопками.
  var dragged = null;

  function rowsOf(list) {
    return Array.prototype.slice.call(list.querySelectorAll('.option-row'));
  }

  function persistOrder(list) {
    var ids = rowsOf(list).map(function (row) { return Number(row.dataset.optionId); });
    // _csrf идёт в теле — csrfProtection читает именно req.body._csrf, отдельного заголовка
    // в проекте не предусмотрено (см. src/middlewares/csrf.js).
    fetch('/admin/item-options/groups/' + list.dataset.groupId + '/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ids, _csrf: list.dataset.csrf }),
    }).then(function (res) {
      // На экране порядок уже новый; если сервер его не принял (403/500) — расходиться
      // молча хуже, чем перезагрузить и показать реальное состояние.
      if (!res.ok) window.location.reload();
    }).catch(function () {
      window.location.reload();
    });
  }

  document.addEventListener('dragstart', function (e) {
    var row = e.target.closest && e.target.closest('.option-row');
    if (!row) return;
    dragged = row;
    row.classList.add('is-dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });

  document.addEventListener('dragend', function () {
    if (dragged) dragged.classList.remove('is-dragging');
    dragged = null;
  });

  document.addEventListener('dragover', function (e) {
    if (!dragged) return;
    var row = e.target.closest && e.target.closest('.option-row');
    if (!row || row === dragged) return;
    var list = row.closest('.option-list');
    if (!list || list !== dragged.closest('.option-list')) return;

    e.preventDefault();
    var rect = row.getBoundingClientRect();
    var after = (e.clientY - rect.top) > rect.height / 2;
    list.insertBefore(dragged, after ? row.nextSibling : row);
  });

  document.addEventListener('drop', function (e) {
    if (!dragged) return;
    var list = dragged.closest('.option-list');
    e.preventDefault();
    if (list) persistOrder(list);
  });
})();
