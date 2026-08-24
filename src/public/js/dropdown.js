(function () {
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.item-menu[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
})();
