(function () {
  // Промт 4.2. Раньше это был инлайновый <script> в admin/subscription.ejs. Логика простая:
  // выбор срока подписки переключает сумму к оплате, которую владелец копирует в перевод.
  // Цены приходят из разметки готовым JSON (data-prices), считать их на клиенте нельзя —
  // это данные сервиса, а не арифметика.
  var amountEl = document.getElementById('subAmountValue');
  if (!amountEl) return;

  var prices;
  try {
    prices = JSON.parse(amountEl.getAttribute('data-prices') || '[]');
  } catch (err) {
    return;
  }

  document.addEventListener('change', function (event) {
    var radio = event.target;
    if (!radio || radio.name !== 'months') return;

    var match = prices.find(function (option) { return String(option.months) === radio.value; });
    if (match) amountEl.textContent = match.price.toLocaleString('ru-RU');
  });
}());
