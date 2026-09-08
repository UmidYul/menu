(function () {
  // Общий обработчик кнопок "скопировать": data-copy-target — id элемента со значением,
  // data-copy-note (необязательно) — id элемента "скопировано", который на 2с становится видимым.
  document.querySelectorAll('[data-copy-target]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var valueEl = document.getElementById(btn.dataset.copyTarget);
      var note = btn.dataset.copyNote ? document.getElementById(btn.dataset.copyNote) : null;
      if (!valueEl || !navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(valueEl.textContent.trim()).then(function () {
        if (!note) return;
        // Через атрибут hidden, а не style.display: глобальное правило [hidden]{display:none
        // !important} в design-system.css перебивает инлайновый display, и старый способ
        // на таких заметках просто перестал бы работать.
        note.hidden = false;
        window.setTimeout(function () { note.hidden = true; }, 2000);
      }).catch(function () {});
    });
  });
})();
