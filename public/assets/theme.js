// Runs before first paint (loaded in <head>, no defer) so the workspace never flashes the wrong theme. The public site is always light.
(function () {
  try {
    var de = document.documentElement;
    if (de.getAttribute("data-surface") !== "desk") return;
    var t = localStorage.getItem("lbt-theme");
    if (!t && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches && localStorage.getItem("lbt-theme-auto") !== "off") t = "dark";
    if (t === "dark") de.setAttribute("data-theme", "dark");
  } catch (e) { /* storage blocked: stay light */ }
})();
