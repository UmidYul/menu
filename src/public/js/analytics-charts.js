(function () {
  // Промт 3.2: "значение показывается при наведении и по тапу на мобильном" — тултип один на
  // график, позиционируется над последним активным баром через transform: translateX, не через
  // JS-расчёт left/top на каждое событие (дешевле, не требует пересчёта при ресайзе).
  document.querySelectorAll('.analytics-chart').forEach(function (chart) {
    var svg = chart.querySelector('.analytics-chart-svg');
    var tooltip = chart.querySelector('.analytics-chart-tooltip');
    if (!svg || !tooltip) return;

    function showTooltip(bar) {
      tooltip.textContent = bar.dataset.label + ': ' + bar.dataset.value;
      tooltip.hidden = false;
      var barRect = bar.getBoundingClientRect();
      var chartRect = chart.getBoundingClientRect();
      var centerX = barRect.left + barRect.width / 2 - chartRect.left;
      tooltip.style.left = centerX + 'px';
    }

    function hideTooltip() {
      tooltip.hidden = true;
    }

    svg.querySelectorAll('.analytics-bar').forEach(function (bar) {
      bar.addEventListener('mouseenter', function () { showTooltip(bar); });
      bar.addEventListener('mouseleave', hideTooltip);
      bar.addEventListener('focus', function () { showTooltip(bar); });
      bar.addEventListener('blur', hideTooltip);
      // Тап на мобильном: показываем и не даём событию уйти дальше document (иначе следующий
      // же клик где угодно на странице сразу закрыл бы тултип, не дав его прочитать).
      bar.addEventListener('touchstart', function (e) {
        e.stopPropagation();
        showTooltip(bar);
      }, { passive: true });
    });

    document.addEventListener('touchstart', hideTooltip);
  });
})();
