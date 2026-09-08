(function () {
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.item-menu[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
})();

(function () {
  // Промт 3.6. Поиск внутри переключателя заведений. Отдельного файла не завожу: это то же
  // выпадающее меню на <details>, что и остальные, и живёт оно в том же месте.
  document.addEventListener('input', function (event) {
    var input = event.target;
    if (!input || !input.hasAttribute || !input.hasAttribute('data-venue-search')) return;

    var panel = input.closest('.item-menu-panel');
    if (!panel) return;

    var query = (input.value || '').trim().toLowerCase();
    var visible = 0;
    Array.prototype.forEach.call(panel.querySelectorAll('[data-venue-row]'), function (row) {
      var match = !query || row.getAttribute('data-venue-name').indexOf(query) !== -1;
      row.hidden = !match;
      if (match) visible += 1;
    });

    var empty = panel.querySelector('[data-venue-empty]');
    if (empty) empty.hidden = visible !== 0;
  });
}());
