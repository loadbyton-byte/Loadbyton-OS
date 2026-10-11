# Loadbyton OS — complete identity pack v1.0

**Review candidate. Owner approval pending.** Based on Project-Loadbyton commit `8c0e8e9f5239b1689f333ec21cdb9cdffc7e2fa4`, its guidelines, colour/type direction and stacked-BY wordmark. The parent's MIT notice and all font OFL notices are included. The reference icon/favicon SVGs were malformed; they are not reused.

## Open and download

- Browser library: `/brand/index.html` on the running application. It also works through an ordinary static server with this folder as its root.
- Complete guidelines: `guidelines.html` and `exports/guidelines.pdf`.
- Visual overview: `brand-overview.png` and `brand-overview.svg`.
- Complete ZIP: `downloads/loadbyton-os-brand-kit.zip`.
- Editable presentation: `exports/loadbyton-os-brand-deck.pptx` (nine native-text/native-shape slides, logo PNGs embedded).
- Machine-readable inventories: `asset-index.json`, `export-index.json`, `checksums.json`, `colour-specs.json`, `contrast-report.json`, `design-tokens.json`.

The ZIP is self-contained for viewing and editing; it includes fonts, licenses, templates, guides, exports and rebuild sources. To rebuild from a downloaded ZIP, copy `loadbyton-os-brand-kit/` into a repository's `public/brand/` and the supplied `scripts/` into that repository's `scripts/`; use the commands below with the repository's existing Node dependency installation.

## Supplied assets

| Category | Contents |
|---|---|
| Identity | Parent, `.store` and operating-platform outlined masters; navy, white, black and monochrome-white variants; standalone BY geometry |
| Product family | Eight navy/white product lockups: Freight, Transport, Warehouse, Fulfilment, Delivery, Customs, Finance, Intelligence |
| Browser/app | Simplified SVG favicon, ICO 16/32/48, PNGs, touch 180, app 192/512 and maskable 512 |
| Colour/type | Source-aligned palette, RGB and approximate unprofiled CMYK inventory, measured text contrast, JSON/CSS tokens; self-hosted and installable Geist, Inter, JetBrains Mono, Noto Sans Arabic |
| Icons | Twenty-four 24-unit originals: eighteen sector icons plus finance, intelligence, documents, security, support and settings; SVG sprite |
| Graphic language | Container grid, divider rhythm, connected route; shipment/warehouse/document/cash illustrations and four empty/restricted/maintenance states |
| Digital templates | Square, portrait, story, Open Graph, LinkedIn post/personal/company covers, X cover, YouTube safe-area cover, web hero, email header, launch announcement and presentation cover/content/closing |
| Print | Business card front/back, A4 letterhead, sales one-pager, proposal cover, DL envelope and internal staff badge |
| Document layouts | Invoice, packing-list and POD visual templates; none certifies an operational or legal state |
| Communication | Editable HTML email signature, transactional-email scaffold and scoped social-copy bank |
| Handoff | Browser gallery with search/category/downloads; guidelines; native-text PPTX; approval checklist; source and font notices; SHA-256 catalogue and checked ZIP |

## Edit and export

Logos and app marks are path-only SVG files. Templates in `templates/` preserve editable text; install the supplied TTF fonts in your design tool. Matching `outlined/templates/` files contain no font dependency. Export PNGs and PDFs from the outlined copies for identical typography across tools.

`brand.config.json` contains the palette, type families, source commit, contact placeholders and approval fields. The fixed core lockup geometry is defined in `scripts/build-brand.py`. To change wording or contact details, update the config and template text, rebuild and visually review. Bracketed placeholders are intentionally not real legal/contact records.

From the repository root:

```sh
python3 -m venv /tmp/loadbyton-brand-venv
/tmp/loadbyton-brand-venv/bin/pip install -r scripts/brand-requirements.txt
/tmp/loadbyton-brand-venv/bin/python scripts/build-brand.py
CHROME=/usr/bin/chromium node scripts/export-brand.mjs
/tmp/loadbyton-brand-venv/bin/python scripts/package-brand.py
```

The renderer uses the existing `playwright-core` development dependency. Set `CHROME` to your installed Chromium executable. In a controlled container where Chromium cannot use its sandbox, set `CHROME_NO_SANDBOX=true`; the default keeps the sandbox enabled. No application server, database, provider credentials or network access is needed after the tools/fonts are installed.

Python fonts/packages and the browser are build tools, not new production application dependencies. The self-hosted fonts are Fontsource Variable 5.3.0 releases, with their original SIL OFL notices. Latin subsets are supplied for the three Latin families; Arabic and Latin subsets are supplied for Noto Sans Arabic. This does not promise full non-Latin coverage or reviewed Arabic copy.

## Print and approval limits

Print SVG/PDF artboards include 3 mm bleed where stated. For example, the 85 × 55 mm business card is exported at 91 × 61 mm; A4 is 216 × 303 mm. Keep live content at least 5 mm inside the trim. Crop marks and imposition are not added. Staff badges are 60 × 96 mm without automatic bleed.

PDFs preserve vector geometry but use RGB. CMYK values are approximate unprofiled calculations, not press-ready colour conversions. A printer must select the ICC profile, paper, production standard and proof. The assets are not certified PDF/X files. The PPTX embeds PNG logo artwork and editable text/shapes; SVG masters remain separately available.

The old PDF-extracted `logo-navy.png` and `logo-silver.png` remain in the checkout for compatibility, are not used by the updated application, and are excluded from the new ZIP. The new raster counterparts are in `exports/`.

Review `approval-checklist.md`. Brand acceptance, trademark clearance, native Arabic/legal/tax review, domain registrant evidence and real business/support/governance evidence remain open. A manifest is branding metadata, not an offline/PWA capability implementation. Product lockups are not availability attestations. E-invoicing/Mirsal/live feeds/OCR/general ledger/foreign-currency/device-feed gates are unaffected.
