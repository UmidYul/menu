(function () {
  // Промт 2.5. Офлайн-страница — статический файл, отрендерить её сервером в момент показа
  // нельзя (сервера как раз и нет). Язык берём из cookie menu_lang, которую ставит страница
  // меню; её нет — остаётся русский, уже написанный в разметке.
  function cookieLang() {
    var match = /(?:^|;\s*)menu_lang=(ru|uz|en)/.exec(document.cookie || '');
    return match ? match[1] : null;
  }

  var lang = cookieLang();
  if (lang && lang !== 'ru') {
    document.documentElement.lang = lang;
    Array.prototype.forEach.call(document.querySelectorAll('[data-' + lang + ']'), function (el) {
      el.textContent = el.getAttribute('data-' + lang);
    });
  }

  var retry = document.getElementById('offlineRetry');
  if (retry) {
    retry.addEventListener('click', function () {
      // Именно reload, а не переход по ссылке: адрес страницы уже тот, что нужен гостю, —
      // service worker подставил эту разметку вместо ответа на его собственный запрос.
      window.location.reload();
    });
  }
}());
