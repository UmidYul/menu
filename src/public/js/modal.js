(function () {
  document.querySelectorAll('dialog.modal').forEach(function (dialog) {
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });
  });
})();
