// Progressive enhancement only: every page works without JavaScript.
document.addEventListener("click", function (e) {
  var t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest("[data-print]")) { window.print(); return; }
  var add = t.closest("[data-add-row]");
  if (add) {
    var tpl = document.getElementById(add.getAttribute("data-add-row"));
    if (tpl && tpl.content) tpl.parentNode.insertBefore(tpl.content.cloneNode(true), tpl);
  }
  var rm = t.closest("[data-remove-row]");
  if (rm) { var row = rm.closest(".line-row"); if (row && document.querySelectorAll(".line-row").length > 1) row.remove(); }
});
document.addEventListener("submit", function (e) {
  var f = e.target;
  if (f instanceof HTMLFormElement && f.hasAttribute("data-confirm") && !window.confirm(f.getAttribute("data-confirm"))) e.preventDefault();
});

// Navigation, motion and search enhance server-rendered pages without replacing
// form submissions, CSRF checks or role-filtered links.
(function () {
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if ('IntersectionObserver' in window && !reduced.matches) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
      });
    }, { threshold: 0.06 });
    document.querySelectorAll('[data-reveal]').forEach(function (el) {
      // Elements already visible never disappear while the script boots.
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-visible');
      el.classList.add('reveal-ready'); observer.observe(el);
    });
  }
  var siteButton = document.querySelector('[data-site-menu]');
  if (siteButton) {
    siteButton.hidden = false;
    var siteHead = siteButton.closest('.site-head'); siteHead.classList.add('is-enhanced');
    siteButton.addEventListener('click', function () {
      var open = siteHead.classList.toggle('is-open'); siteButton.setAttribute('aria-expanded', String(open));
    });
  }
  var sideButton = document.querySelector('[data-sidebar-toggle]');
  if (sideButton) {
    sideButton.hidden = false; document.body.classList.add('sidebar-enhanced');
    sideButton.addEventListener('click', function () {
      var open = document.body.classList.toggle('sidebar-open'); sideButton.setAttribute('aria-expanded', String(open));
    });
  }
  var scenes = document.querySelectorAll('[data-hero-scene]');
  scenes.forEach(function (button) {
    button.addEventListener('click', function () {
      var selected = Number(button.getAttribute('data-hero-scene'));
      document.querySelectorAll('.hero-image').forEach(function (image, i) { image.classList.toggle('is-active', i === selected); });
      scenes.forEach(function (scene, i) { scene.setAttribute('aria-pressed', String(i === selected)); });
    });
  });
  // Only enhance the single-password login form. Signup and automated callers
  // retain their existing button structure and native validation.
  var login = document.querySelector('form[action="/login"]');
  if (login) {
    var pw = login.querySelector('input[type=password]');
    if (pw) {
      var wrapper = document.createElement('div'); wrapper.className = 'password-wrap';
      pw.parentNode.insertBefore(wrapper, pw); wrapper.appendChild(pw);
      var toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'password-toggle';
      var arabic = document.documentElement.lang === 'ar';
      toggle.textContent = arabic ? 'إظهار' : 'Show'; toggle.setAttribute('aria-label', arabic ? 'إظهار كلمة المرور' : 'Show password'); toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-controls', pw.id); wrapper.appendChild(toggle);
      toggle.addEventListener('click', function () {
        var show = pw.type === 'password'; pw.type = show ? 'text' : 'password';
        toggle.textContent = arabic ? (show ? 'إخفاء' : 'إظهار') : (show ? 'Hide' : 'Show'); toggle.setAttribute('aria-label', arabic ? (show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور') : (show ? 'Hide password' : 'Show password'));
        toggle.setAttribute('aria-pressed', String(show));
      });
    }
  }
  var dialog = document.querySelector('[data-command-dialog]');
  var trigger = document.querySelector('[data-command-open]');
  if (dialog && trigger && typeof dialog.showModal === 'function') {
    trigger.hidden = false;
    var query = dialog.querySelector('input'); var links = Array.from(dialog.querySelectorAll('.command-results a'));
    var empty = dialog.querySelector('.command-empty');
    function filter() {
      var text = query.value.trim().toLocaleLowerCase();
      links.forEach(function (link) { link.hidden = !link.textContent.toLocaleLowerCase().includes(text); });
      empty.hidden = links.some(function (link) { return !link.hidden; });
    }
    function open() { if (!dialog.open) { query.value = ''; filter(); dialog.showModal(); query.focus(); } }
    trigger.addEventListener('click', open);
    dialog.querySelector('[data-command-close]').addEventListener('click', function () { dialog.close(); });
    query.addEventListener('input', filter);
    dialog.addEventListener('click', function (event) {
      var box = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
    });
    document.addEventListener('keydown', function (event) {
      // Chromium's search input consumes Escape to clear text before the
      // dialog's native cancel action. Make the documented close key reliable.
      if (dialog.open && event.key === 'Escape') { event.preventDefault(); dialog.close(); return; }
      var editing = event.target instanceof Element && (event.target.closest('input, textarea, select, [contenteditable="true"]'));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !editing) { event.preventDefault(); open(); }
      if (dialog.open && event.key === 'ArrowDown' && event.target === query) {
        var first = links.find(function (link) { return !link.hidden; }); if (first) { event.preventDefault(); first.focus(); }
      }
    });
  }
})();
