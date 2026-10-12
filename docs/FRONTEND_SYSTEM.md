# Interface system: design, motion, engagement and chat

One design system serves the public site, sign-in, the company workspace, the control console and the driver app. This note says where things live and how to change them.

## Sources of the design
- **Brand**: your supplied logo, iconmark and `.store` lockup. Masters are in `public/brand/` (`lbt-logo-*.png/svg`, `lbt-store-*.png/svg`, `lbt-iconmark-*.png`, favicons, app icons, Open Graph card). The wordmark is drawn in text exactly as the logo is: `LOAD`, a stacked `B` over `Y` between two red bars, `TON` (`src/web/brand.tsx` for components, `src/lib/brand-html.ts` for a response filter that does it for every literal "LOAD|BY|TON" in visible text, including pages written as plain text).
- **Workspace and dashboard**: the structure of Elvora Logistics OS (`elvorashippingllc/ElvoraLogisticsOS`, `DESIGN.md`, `src/web/components/Shell.tsx`, `pages/Dashboard.tsx`, `pages/Workspaces.tsx`): capsule navigation, a narrow icon rail that opens a workspace popup, back button and breadcrumb, floating rounded cards, command search, notifications bell, a "needs attention" section, a movement desk of ticket cards, KPI tiles, disclosure sections, a workspaces hub and a 3D-tilting plan card. Re-coloured to navy and red; the data is this product's real tenant data.
- **Public site**: the thirteen public pages of `Project-Loadbyton` (Home, Features, Pricing, About, Blog/Notes, Security, Compliance, Terms, Privacy, Industries, Trust, For Transporters, For Shippers→For forwarders) rebuilt for the operating-software product.
- **Inspiration**: shadcn and 21st.dev patterns (cards, tabs, accordion, command palette, toasts), Jitter-style motion (spring easing, count-ups, marquee, magnetic buttons, spotlight, tilt). All implemented natively; no React runtime or downloaded component bundle was added.
- **Not used**: the Figma "iOS 27" UI kit could not be opened (no kit link was available to the session). The home header follows the same language from first principles: a floating, blurred, translucent capsule with specular edge, only the essentials (logo, four links, WhatsApp, sign-in, start). Send the kit link and the header can be aligned to it exactly.

## Type and tokens
Inter (display, text and labels, variable weight), JetBrains Mono (identifiers such as `LBT-J-0142` only), Noto Sans Arabic. All self-hosted in `public/brand/fonts/`. Tokens are CSS variables in `public/assets/lbt.css` (`:root` light, `:root[data-theme=dark]`). The workspace has a light/dark toggle; the public site is light.

Files: `lbt.css` (tokens + components), `site.css` (public), `desk.css` (workspace, console, driver), `widgets.css` (chat, offer popup), `lbt.js` (reveal, tabs, tilt, command palette, popovers, theme), `engage.js`, `chat.js`, `theme.js`.

Every class that existed before (`btn`, `card`, `badge`, `tbl-wrap`, `field`, `grid g3`, …) was kept, so all ~50 existing workspace screens picked up the new look without being rewritten.

## Hero film
The home hero is three real photographs (`public/assets/photo/hero/`) cut together with CSS only: a letterbox reveal, masked headline rise, a slanted wipe that travels right to left with a push, a rack focus and a light sweep on every cut, a slow drift on each shot, and a dolly-out as the hero scrolls away. A sample load record beside the headline changes with the scene (stage rail 3 → 4 → 5). The scenes advance every 8 s, pause on hover, focus, a hidden tab or when scrolled away, and have a pause button. Under `prefers-reduced-motion` nothing advances automatically and every cut is instant. Without JavaScript the first scene and its record stay on screen. Controller: the "hero film" block in `public/assets/lbt.js`; styles: `site.css`.

## Photography
All imagery is supplied artwork converted to WebP in `public/assets/photo/`: `hero/` (3 scenes), `sectors/` (one per sector pack, named by slug, plus an `-800` card crop) and `product/` (workspace, finance, intelligence, enterprise and sign-in scenes). `PHOTO` and `sectorPhoto(slug)` in `src/web/site-kit.tsx` are the only places that name files.

## Offers, notices and popups (`engage.js`)
- A top **offer bar** with a live countdown. The deadline is real: set `OFFER_ENDS_ON=YYYY-MM-DD`, `OFFER_CODE`, `OFFER_TITLE`, `OFFER_DETAIL`; if unset, a standing monthly onboarding offer runs to the last day of the current month. `OFFER_ENDS_ON=off` hides everything offer-related. **Only publish an offer you will honour.**
- **Timed notices** (glass banners): 16 s, 50 s, 105 s, 175 s, 260 s, 500 s, 760 s into a visit. Capped at 6 per session and 10 per day; none while a dialog or the chat is open; two dismissals silence the session; none on sign-in or recovery pages.
- An **offer popup** on exit intent (desktop) or after ~95 s with scrolling, at most once every three days.
- Nothing is fabricated: no fake "someone just signed up", no per-visitor resetting timers.

## Assistant and live chat (no third-party service)
- **Assistant**: `src/platform/knowledge.ts`. A retrieval assistant over the live catalogue (plans, sectors, products, integrations) plus about 60 written entries. Prices come from the database. When nothing matches well it says so and hands over. Extend by adding entries to `buildKnowledge`. Tests: `tests/site-experience.test.ts`.
- **Live chat**: tables `chat_threads`, `chat_messages` (migration 052, no access for the tenant role). A visitor's browser holds a random secret; only its hash is stored. Staff reply in **Console → Live chats** (`/admin/chats`, staff + MFA). A new conversation queues an email to `CONTACT_EMAIL_SUPPORT`. Staffed hours: `CHAT_TZ`, `CHAT_FROM_HOUR`, `CHAT_TO_HOUR` (default 09:00–21:00 IST). The visitor is told when the team is outside hours.
- Contact points (`CONTACT_PHONE`, `CONTACT_EMAIL_*`) feed the header, footer, assistant, JSON-LD and WhatsApp links (`wa.me`).
- Chat messages are personal data: review retention before launch and include them in the privacy notice.

## Accessibility and fallbacks
Every page works without JavaScript (content is visible, links and forms work). `prefers-reduced-motion` disables animation. Focus rings, 44 px targets, native `<dialog>`, labelled controls. The Arabic layer (`src/lib/i18n-ar-4.ts` adds the workspace strings) renders right-to-left; the new public marketing copy falls back to English until translated.

## Checks
`npm run typecheck`, `npm test`, and `npm run e2e:experience` (hero film, chat, sign-in, recovery, sign-up, dashboard, hub, alerts, command search, dark theme, phone layouts, reduced motion, no-JS).
