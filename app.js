(function () {
  /* ── Platform detection ── */
  var ua       = navigator.userAgent || '';
  var isIOS    = /iPhone|iPad|iPod/i.test(ua);
  var isAndroid= /Android/i.test(ua);
  var isMobile = isIOS || isAndroid;

  if (isIOS)     document.body.classList.add('ios');
  if (isAndroid) document.body.classList.add('android');

  /* ── Desktop: show both store buttons ── */
  if (!isMobile) {
    ['d-ios','d-android','cta-d-ios','cta-d-android'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'flex';
    });
  }

  /* ── Sticky open-in-app bar ── */
  var path = window.location.pathname;
  if (isMobile && path && path !== '/') {
    var bar  = document.getElementById('open-bar');
    var link = document.getElementById('ob-link');
    if (bar && link) {
      link.href = 'whistler://' + path.replace(/^\//, '');
      bar.classList.add('show');
    }
  }

  /* ── Scroll reveal via IntersectionObserver ── */
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function(el) { io.observe(el); });
  } else {
    reveals.forEach(function(el) { el.classList.add('in'); });
  }

  /* ── Desktop: show step arrows ── */
  if (window.matchMedia('(min-width: 960px)').matches) {
    document.querySelectorAll('.step-arrow-icon').forEach(function(el) {
      el.style.display = 'flex';
    });
  }
})();
