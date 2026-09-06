(function () {
  // Только подсказка на клиенте — реальные правила (длина, совпадение с логином, список частых
  // паролей) проверяются на сервере через zod. Здесь — грубая эвристика по длине и разнообразию
  // символов, без внешних библиотек: 4 категории символов + длина.
  function scorePassword(value) {
    if (!value) return 0;
    var categories = 0;
    if (/[a-z]/.test(value)) categories += 1;
    if (/[A-Z]/.test(value)) categories += 1;
    if (/[0-9]/.test(value)) categories += 1;
    if (/[^a-zA-Z0-9]/.test(value)) categories += 1;

    var lengthScore = Math.min(value.length / 16, 1);
    var categoryScore = categories / 4;
    return lengthScore * 0.6 + categoryScore * 0.4;
  }

  function levelFor(score, length) {
    if (length === 0) return null;
    if (length < 8 || score < 0.35) return 'weak';
    if (score < 0.65) return 'medium';
    return 'strong';
  }

  function attach(el) {
    var input = document.getElementById(el.getAttribute('data-strength-for'));
    if (!input) return;

    function render() {
      var value = input.value;
      var level = levelFor(scorePassword(value), value.length);
      el.className = 'password-strength' + (level ? ' password-strength-' + level : '');
      el.textContent = level ? (el.getAttribute('data-label-' + level) || '') : '';
    }

    input.addEventListener('input', render);
    render();
  }

  document.querySelectorAll('.password-strength[data-strength-for]').forEach(attach);
})();
