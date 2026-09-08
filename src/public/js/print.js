(function () {
  // Экран печатных макетов (промт 3.4). Собирает настройки в query и отдаёт их обеим кнопкам —
  // предпросмотру и скачиванию, чтобы гарантированно рисовалось одно и то же.
  var layoutsEl = document.getElementById('printLayouts');
  if (!layoutsEl) return;

  var labelsEl = document.getElementById('printLabels');
  var L = labelsEl ? JSON.parse(labelsEl.textContent) : {};

  var tablesField = document.getElementById('printTablesField');
  var previewBtn = document.getElementById('printPreviewBtn');
  var downloadBtn = document.getElementById('printDownloadBtn');
  var techSize = document.getElementById('printTechSize');
  var techBleed = document.getElementById('printTechBleed');
  var modal = document.getElementById('print-preview-modal');
  var stage = document.getElementById('printPreviewStage');
  var previewNote = document.getElementById('printPreviewNote');

  function activeCard() {
    return layoutsEl.querySelector('.print-layout.active');
  }

  function buildQuery() {
    var card = activeCard();
    var params = new URLSearchParams();
    params.set('layout', card.dataset.layout);

    document.querySelectorAll('#printLangs input:checked').forEach(function (cb) {
      params.append('langs', cb.value);
    });
    if (document.getElementById('printLogo').checked) params.set('logo', '1');
    if (document.getElementById('printContacts').checked) params.set('contacts', '1');

    if (card.dataset.perTable) {
      var from = document.getElementById('printFrom');
      var to = document.getElementById('printTo');
      if (from && to && from.value && to.value) {
        params.set('from', from.value);
        params.set('to', to.value);
      }
    }
    return params.toString();
  }

  function syncUi() {
    var card = activeCard();
    var perTable = Boolean(card.dataset.perTable);
    if (tablesField) tablesField.hidden = !perTable;

    var size = card.querySelector('.print-layout-size').textContent.trim().split('·')[0].trim();
    if (techSize && L.size) techSize.textContent = L.size.replace('__W__', size).replace('__H__', '');
    if (techBleed) techBleed.textContent = card.dataset.layout.indexOf('sheet-') === 0 ? L.noBleed : L.bleed;

    downloadBtn.href = '/admin/print/download.pdf?' + buildQuery();
  }

  layoutsEl.addEventListener('click', function (e) {
    var card = e.target.closest('.print-layout');
    if (!card) return;
    layoutsEl.querySelectorAll('.print-layout').forEach(function (c) { c.classList.toggle('active', c === card); });
    syncUi();
  });

  // Любая смена настроек сразу пересобирает ссылку скачивания — иначе владелец нажал бы
  // «Скачать» и получил PDF со старыми параметрами.
  document.querySelectorAll('#printLangs input, #printLogo, #printContacts, #printFrom, #printTo')
    .forEach(function (input) { input.addEventListener('change', syncUi); });

  previewBtn.addEventListener('click', function () {
    stage.innerHTML = '';
    previewNote.textContent = '';
    modal.showModal();

    fetch('/admin/print/preview.svg?' + buildQuery())
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (svg) {
        if (!svg) {
          previewNote.textContent = L.previewFailed;
          return;
        }
        stage.innerHTML = svg;
        previewNote.textContent = L.previewNote;
      })
      .catch(function () { previewNote.textContent = L.previewFailed; });
  });

  syncUi();
})();
