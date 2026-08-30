document.documentElement.classList.add('js-reveal');

(function () {
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // --- появление элементов при скролле (+ счётчики в .stats) ------------------------------
  // [data-reveal] по умолчанию видим всегда — .js-reveal (см. верх файла) отдельно переводит
  // его в скрытое стартовое состояние в CSS, так что без JS или до его выполнения ничего не
  // пропадает. Общий IntersectionObserver обслуживает и карточки/строки (data-reveal), и
  // счётчики в .stats (data-count) — оба типа отписываются после первого срабатывания.
  var revealTargets = document.querySelectorAll('[data-reveal]');
  var countTargets = document.querySelectorAll('[data-count]');
  var reduced = prefersReducedMotion();

  function revealElement(el) {
    var delay = el.getAttribute('data-reveal-delay');
    if (delay) el.style.transitionDelay = delay + 'ms';
    el.classList.add('is-revealed');
  }

  function animateCount(el) {
    var text = el.textContent;
    var match = text.match(/^(\d+)/);
    if (!match) {
      el.classList.add('is-revealed');
      return;
    }
    var target = parseInt(match[1], 10);
    var suffix = text.slice(match[0].length);
    if (reduced) {
      el.textContent = target + suffix;
      el.classList.add('is-revealed');
      return;
    }
    el.classList.add('is-revealed');
    var duration = 900;
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var progress = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(eased * target) + suffix;
      if (progress < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  if (reduced) {
    revealTargets.forEach(function (el) { el.classList.add('is-revealed'); });
    countTargets.forEach(function (el) {
      var match = el.textContent.match(/^(\d+)/);
      if (match) el.textContent = match[1] + el.textContent.slice(match[0].length);
      el.classList.add('is-revealed');
    });
  } else if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        obs.unobserve(entry.target);
        if (entry.target.hasAttribute('data-count')) {
          animateCount(entry.target);
        } else {
          revealElement(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });
    revealTargets.forEach(function (el) { observer.observe(el); });
    countTargets.forEach(function (el) { observer.observe(el); });
  } else {
    // Нет поддержки IntersectionObserver — показываем всё сразу, без деградации контента.
    revealTargets.forEach(function (el) { el.classList.add('is-revealed'); });
    countTargets.forEach(function (el) { el.classList.add('is-revealed'); });
  }

  // --- бургер-меню -------------------------------------------------------------------------
  var toggle = document.getElementById('mobileMenuToggle');
  var panel = document.getElementById('navLinks');
  if (toggle && panel) {
    var closePanel = function () {
      panel.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    };

    toggle.addEventListener('click', function () {
      var isOpen = panel.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });

    panel.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', closePanel);
    });

    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || toggle.contains(e.target)) return;
      closePanel();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });
  }

  // --- FAQ: анимированное раскрытие <details> -----------------------------------------------
  // Details остаётся полностью нативным (работает и без JS — открытие/закрытие мгновенное).
  // При наличии JS клик по summary перехватывается: открытие ставит [open] сразу и на следующий
  // кадр включает класс, который анимирует grid-template-rows; закрытие сначала анимирует его
  // обратно и только по transitionend снимает [open] — иначе контент схлопнется мгновенно
  // (display:none у закрытых <details> нельзя анимировать).
  document.querySelectorAll('.faq-item').forEach(function (details) {
    var summary = details.querySelector('summary');
    var content = details.querySelector('.faq-content');
    if (!summary || !content) return;

    summary.addEventListener('click', function (e) {
      e.preventDefault();
      if (reduced) {
        details.open = !details.open;
        details.classList.toggle('is-open', details.open);
        content.classList.toggle('is-expanded', details.open);
        return;
      }
      if (details.classList.contains('is-open')) {
        details.classList.remove('is-open');
        content.classList.remove('is-expanded');
        var onEnd = function (ev) {
          if (ev.target !== content || ev.propertyName !== 'grid-template-rows') return;
          details.open = false;
          content.removeEventListener('transitionend', onEnd);
        };
        content.addEventListener('transitionend', onEnd);
      } else {
        details.open = true;
        details.classList.add('is-open');
        requestAnimationFrame(function () {
          content.classList.add('is-expanded');
        });
      }
    });
  });
})();
