"use strict";
(async () => {
  const grid = document.getElementById("asset-grid");
  if (!grid) return;
  const count = document.getElementById("asset-count");
  const search = document.getElementById("asset-search");
  const category = document.getElementById("asset-category");
  const empty = document.getElementById("empty-results");
  try {
    const response = await fetch("asset-index.json");
    if (!response.ok) throw new Error("Catalogue unavailable");
    const { assets } = await response.json();
    for (const name of [...new Set(assets.map(a => a.category))]) {
      const option = document.createElement("option");
      option.value = name; option.textContent = name; category.append(option);
    }
    function link(label, href) {
      const a = document.createElement("a"); a.textContent = label; a.href = href; a.download = ""; return a;
    }
    function render() {
      const term = search.value.toLowerCase().trim();
      const shown = assets.filter(a => (!category.value || a.category === category.value) && (a.title + " " + a.path).toLowerCase().includes(term));
      grid.replaceChildren();
      for (const asset of shown) {
        const article = document.createElement("article"); article.className = "asset-card";
        const preview = document.createElement("div");
        preview.className = "asset-preview" + (/white|silver/.test(asset.path) ? " dark" : "");
        const img = document.createElement("img");
        img.src = asset.editableText ? "outlined/" + asset.path : asset.path;
        img.alt = asset.title; img.loading = "lazy"; preview.append(img);
        const info = document.createElement("div"); info.className = "asset-info";
        const heading = document.createElement("h3"); heading.textContent = asset.title;
        const dimensions = document.createElement("p");
        dimensions.textContent = asset.physicalMm ? asset.physicalMm.join(" × ") + " mm / bleed included" : asset.width + " × " + asset.height + " / SVG";
        const links = document.createElement("div"); links.className = "asset-links";
        links.append(link(asset.editableText ? "Editable SVG" : "Vector SVG", asset.path));
        if (asset.editableText) links.append(link("Outlined SVG", "outlined/" + asset.path));
        const stem = asset.path.replace(/\.svg$/, "");
        if (asset.category !== "Sector and UI icons" && asset.category !== "Patterns") links.append(link("PNG", "exports/" + stem + ".png"));
        if (["Print templates", "Document templates", "Digital templates", "Logo masters", "Brand guide"].includes(asset.category)) links.append(link("PDF", "exports/" + stem + ".pdf"));
        info.append(heading, dimensions, links); article.append(preview, info); grid.append(article);
      }
      count.textContent = shown.length + " / " + assets.length + " ASSETS";
      empty.hidden = shown.length !== 0;
    }
    search.addEventListener("input", render); category.addEventListener("change", render); render();
  } catch {
    count.textContent = "Catalogue unavailable — use the ZIP download";
  }
})();
