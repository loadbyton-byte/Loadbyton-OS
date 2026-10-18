/* Features page: show, as boxes are ticked, whether the choice is free or which monthly plan it needs. The server re-checks everything on submit. */
(function () {
  var form = document.querySelector("[data-feature-form]");
  if (!form) return;
  var text = form.querySelector("[data-plan-text]"), hours = form.dataset.hours || "24";
  var boxes = form.querySelectorAll("input[type=checkbox][name=feature]");
  function update() {
    var n = 0, paid = 0, rank = 0, name = "", price = "";
    boxes.forEach(function (b) {
      if (!b.checked) return;
      n++;
      if (b.dataset.tier === "paid") {
        paid++;
        var r = Number(b.dataset.planRank || 0);
        if (r > rank) { rank = r; name = b.dataset.planName; price = b.dataset.planPrice; }
      }
    });
    if (!n) text.textContent = "Tick features to see what they need. Free features cost nothing.";
    else if (!paid) text.textContent = n + " free feature" + (n > 1 ? "s" : "") + ": no charge. We deliver them within " + hours + " hours once your brand kit is in.";
    else text.textContent = n + " selected, " + paid + " paid. These need the " + name + " plan: " + price + " a month. You will see the exact amount, VAT and setup fee before you pay.";
  }
  boxes.forEach(function (b) { b.addEventListener("change", update); });
  update();
})();
