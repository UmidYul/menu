(function () {
  // Общий обработчик кнопок "скопировать": data-copy-target — id элемента со значением,
  // data-copy-note (необязательно) — id элемента "скопировано", который на 2с становится видимым.
  document.querySelectorAll('[data-copy-target]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var valueEl = document.getElementById(btn.dataset.copyTarget);
      var note = btn.dataset.copyNote ? document.getElementById(btn.dataset.copyNote) : null;
      if (!valueEl || !navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(valueEl.textContent).then(function () {
        if (!note) return;
        note.style.display = 'inline-flex';
        setTimeout(function () { note.style.display = 'none'; }, 2000);
      });
    });
  });
})();
