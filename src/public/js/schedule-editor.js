(function () {
  // Промт 2.3. Единственная задача этого файла — кнопки-пресеты: они ЗАПОЛНЯЮТ форму добавления
  // интервала, дальше владелец правит руками и жмёт «Добавить». Ничего не сохраняют сами и
  // ничего не считают — вся доступность вычисляется на сервере (см. services/availability.js).
  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.schedule-preset-btn') : null;
    if (!button) return;

    var form = button.closest('[data-schedule-add]');
    if (!form) return;

    var days = (button.dataset.presetDays || '').split(',').filter(Boolean);
    Array.prototype.forEach.call(form.querySelectorAll('input[name="days"]'), function (input) {
      input.checked = days.indexOf(input.value) !== -1;
    });

    var from = form.querySelector('input[name="time_from"]');
    var to = form.querySelector('input[name="time_to"]');
    if (from) from.value = button.dataset.presetFrom || from.value;
    if (to) to.value = button.dataset.presetTo || to.value;

    // Фокус на кнопке отправки: после пресета остаётся один осмысленный шаг, и он должен быть
    // под рукой и у клавиатуры тоже.
    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.focus();
  });
}());
