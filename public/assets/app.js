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
