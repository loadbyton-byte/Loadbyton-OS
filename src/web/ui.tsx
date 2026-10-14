import type { Child } from "hono/jsx";
import { Icon, SECTION_BLURB, SECTION_ICON, slugOf } from "./experience.js";
import { B, CONTACT, Lbt, activeOffer, chatStaffed, waLink } from "./brand.js";
import { config } from "../config.js";
import { fmtMoney } from "../lib/util.js";
import { SECTORS } from "../platform/catalog.js";

export interface Page {
  title: string; csrf: string; path: string; description?: string;
  ok?: string; err?: string; user?: { name: string } | null; head?: Child;
  offlineScope?: string;
  /** Public pages that open with a dark hero let the floating header start in its light-on-dark state. */
  heroDark?: boolean;
  /** Public pages that should not carry the chat, offers and notices (sign-in, recovery). */
  quiet?: boolean;
}

export const Money = ({ v, cur = "AED" }: { v: number | string; cur?: string }) => <bdi class="nowrap" dir="ltr">{fmtMoney(v, cur)}</bdi>;

const BADGE: Record<string, string> = {
  pilot: "warn", planned: "info", available: "ok", live: "ok", paid: "ok", active: "ok", approved: "ok", converted: "ok", accepted: "ok", delivered: "ok",
  operationally_complete: "ok", collected: "ok", closed: "ok", synced: "ok", resolved: "ok", ready: "ok", onboarding: "ok", won: "ok", verified: "ok", sent: "info",
  pending: "warn", pending_approval: "warn", draft: "info", open: "warn", invoiced: "info", issued: "info", part_paid: "warn", grace: "warn",
  qualified: "info", new: "info", quoted: "info", queued: "info", provisioning: "info", validation: "info", information_pending: "warn", in_transit: "info", planned_job: "info",
  allocated: "info", picking: "info", picked: "info", packed: "info", shipped: "ok", receiving: "warn", backordered: "warn", received: "ok", expected: "info", stale: "bad",
  failed: "bad", rejected: "bad", lost: "bad", restricted: "bad", void: "bad", expired: "bad", dead: "bad", refunded: "bad", cancelled: "bad", denied: "bad", requested: "warn", revoked: "bad",
};
export const Badge = ({ s, label }: { s: string; label?: string }) => (
  <span class={`badge ${BADGE[s] ?? ""}`}>{(label ?? s).replace(/_/g, " ")}</span>
);

export const Csrf = ({ t }: { t: string }) => <input type="hidden" name="_csrf" value={t} />;

export const Flash = ({ ok, err }: { ok?: string; err?: string }) => (
  <>
    {ok ? <div class="alert ok" role="status"><Icon name="check" /><span><strong>Done.</strong> {ok}</span></div> : null}
    {err ? <div class="alert err" role="alert"><Icon name="alert" /><span><strong>Problem.</strong> {err}</span></div> : null}
  </>
);

function Head({ p, surface }: { p: Page; surface: "public" | "desk" }) {
  const app = p.path.startsWith("/app") || p.path.startsWith("/admin");
  const desc = p.description ?? "Your logistics company, connected. Start free, choose the tools your business needs, and run enquiries, jobs, documents, deliveries and collections from one branded workspace.";
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{p.title} · LOAD|BY|TON.store</title>
      <meta name="description" content={desc} />
      <meta name="theme-color" content="#0F2B3D" />
      <meta name="csrf-token" content={p.csrf} />
      {p.offlineScope ? <meta name="driver-scope" content={p.offlineScope} /> : null}
      <link rel="icon" href="/brand/favicon.ico" sizes="any" />
      <link rel="icon" href="/brand/favicon-32.png" type="image/png" sizes="32x32" />
      <link rel="icon" href="/brand/favicon-16.png" type="image/png" sizes="16x16" />
      <link rel="icon" href="/brand/app-icon-192.png" type="image/png" sizes="192x192" />
      <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180" />
      {!p.path.startsWith("/app/driver") ? <link rel="manifest" href="/brand/site.webmanifest" /> : null}
      {!app ? <>
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="LOAD|BY|TON.store" />
        <meta property="og:title" content={p.title + " · LOAD|BY|TON.store"} />
        <meta property="og:description" content={desc} />
        <meta property="og:image" content={new URL("/brand/exports/templates/open-graph.png", config.baseUrl).href} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="LOAD|BY|TON.store — Run the movement. Know the margin." />
        <meta name="twitter:card" content="summary_large_image" />
      </> : null}
      <link rel="preload" href="/brand/fonts/inter.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
      <script src="/assets/theme.js"></script>
      <link rel="stylesheet" href="/assets/lbt.css" />
      <link rel="stylesheet" href={surface === "public" ? "/assets/site.css" : "/assets/desk.css"} />
      {surface === "public" ? <link rel="stylesheet" href="/assets/widgets.css" /> : null}
      <script src="/assets/lbt.js" defer></script>
      {surface === "public" && !p.quiet ? <script src="/assets/engage.js" defer></script> : null}
      {surface === "public" && !p.quiet ? <script src="/assets/chat.js" defer></script> : null}
      {p.path.startsWith("/app/driver") ? <link rel="manifest" href="/app/driver/manifest.webmanifest" /> : null}
      {p.path.startsWith("/app/driver") ? <script src="/assets/driver.js" defer></script> : null}
      {p.head ?? null}
    </head>
  );
}

export const PUBLIC_NAV: [string, string][] = [["/features", "Platform"], ["/sectors", "Sectors"], ["/pricing", "Pricing"], ["/about", "About"]];
const SHEET_NAV: [string, string][] = [
  ["/features", "Platform"], ["/sectors", "Sectors"], ["/industries", "Who it is for"], ["/pricing", "Pricing"], ["/trust", "Trust & safety"], ["/security", "Security"],
  ["/blog", "Notes"], ["/about", "About"], ["/contact", "Contact"], ["/login", "Sign in"],
];

function OfferBar() {
  const o = activeOffer();
  if (!o) return null;
  return (
    <div class="offer-bar" data-offer data-ends={o.endsAt} data-code={o.code} data-title={o.title} data-detail={o.detail} data-label={o.endsLabel} role="region" aria-label="Current offer">
      <div class="wrap">
        <span class="tag">OFFER</span>
        <span><b>{o.title}.</b> Ends {o.endsLabel}.</span>
        <span class="cd" data-cd aria-hidden="true"></span>
        <a href={`/start?offer=${encodeURIComponent(o.code)}`}>Claim it</a>
        <button type="button" data-offer-close aria-label="Hide offer" hidden>×</button>
      </div>
    </div>
  );
}

export const PublicShell = ({ p, children }: { p: Page; children: Child }) => {
  const staffed = chatStaffed();
  const palette = [...SHEET_NAV.slice(0, -1), ["/start", "Start free"], ["/legal/terms", "Terms"], ["/legal/privacy", "Privacy"], ["/help", "Help"], ["/status", "Service status"]] as [string, string][];
  return (
    <html lang="en" data-surface="public">
      <Head p={p} surface="public" />
      <body class="public-experience">
        <a class="skip" href="#main">Skip to content</a>
        {p.quiet ? null : <OfferBar />}
        <header class={`site-head${p.heroDark && !p.quiet ? " on-dark" : ""}${p.quiet ? " solid" : ""}`}>
          <div class="bar">
            <a class="brand" href="/" aria-label="LOAD|BY|TON home">
              <img class="logo-light" src="/brand/lbt-logo-navy.png" alt="LOAD|BY|TON" width="140" height="38" />
              <img class="logo-dark" src="/brand/lbt-logo-white.png" alt="" width="140" height="38" />
            </a>
            <nav class="nav" id="public-navigation" aria-label="Main">
              {PUBLIC_NAV.map(([h, l]) => <a class="l" href={h} aria-current={p.path === h || (h !== "/" && p.path.startsWith(h + "/")) ? "page" : undefined}>{l}</a>)}
            </nav>
            <div class="head-cta">
              <a class="wa-mini" href={waLink()} target="_blank" rel="noopener" aria-label="Chat on WhatsApp"><Icon name="whatsapp" size={20} /></a>
              {p.user ? <a class="btn red sm" href="/app">Open workspace</a> : (
                <>
                  <a class="signin" href="/login">Sign in</a>
                  <a class="btn red sm" href="/start">Start free<span class="hide-s"> <Icon name="arrow" size={16} /></span></a>
                </>
              )}
              <button class="site-menu-toggle" type="button" data-site-menu aria-expanded="false" aria-controls="sheet-menu" aria-label="Menu"><Icon name="menu" /></button>
            </div>
          </div>
          <nav class="sheet-menu" id="sheet-menu" aria-label="All pages">
            {SHEET_NAV.map(([h, l]) => <a href={h}>{l}<Icon name="arrow" size={16} /></a>)}
            <a href={waLink()} target="_blank" rel="noopener">WhatsApp {CONTACT.phoneDisplay}<Icon name="whatsapp" size={18} /></a>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer class="site">
          <div class="wrap">
            <div class="foot-grid">
              <div>
                <a class="foot-logo" href="/" aria-label="LOAD|BY|TON.store home"><img src="/brand/lbt-store-white.png" alt="LOAD|BY|TON.store" width="200" height="46" /></a>
                <p class="foot-about">Logistics operating software for freight, transport, warehouse, delivery and customs teams. Built in India, priced for the UAE market.</p>
                <ul class="foot-contact">
                  <li><Icon name="phone" size={18} /><a href={CONTACT.tel}>{CONTACT.phoneDisplay}</a></li>
                  <li><Icon name="whatsapp" size={18} /><a href={waLink()} target="_blank" rel="noopener">Chat on WhatsApp</a></li>
                  <li><Icon name="mail" size={18} /><a href={`mailto:${CONTACT.emails.info}`}>{CONTACT.emails.info}</a></li>
                  <li><Icon name="headset" size={18} /><a href={`mailto:${CONTACT.emails.support}`}>{CONTACT.emails.support}</a></li>
                  <li><Icon name="mail" size={18} /><a href={`mailto:${CONTACT.emails.contact}`}>{CONTACT.emails.contact}</a></li>
                </ul>
              </div>
              <div><h4>Platform</h4><ul><li><a href="/features">Features</a></li><li><a href="/products">Products</a></li><li><a href="/sectors">Sectors</a></li><li><a href="/find-my-bundle">Find my bundle</a></li><li><a href="/pricing">Pricing &amp; plans</a></li><li><a href="/integrations">Integrations</a></li></ul></div>
              <div><h4>Who it is for</h4><ul><li><a href="/industries">Industries</a></li><li><a href="/for-forwarders">Freight forwarders</a></li><li><a href="/for-transporters">Transport &amp; fleets</a></li><li><a href="/coverage">Service coverage</a></li><li><a href="/stories">Customer stories</a></li></ul></div>
              <div><h4>Company</h4><ul><li><a href="/about">About</a></li><li><a href="/trust">Trust &amp; safety</a></li><li><a href="/security">Security</a></li><li><a href="/compliance">Compliance</a></li><li><a href="/blog">Notes</a></li><li><a href="/contact">Contact</a></li><li><a href="/status">Service status</a></li></ul></div>
            </div>
            <div class="foot-bottom">
              <span>© {new Date().getFullYear()} <Lbt />.store — a subsidiary of <Lbt />. All rights reserved.
                {config.seller.legalName ? <> Operated by {config.seller.legalName}{config.seller.address ? `, ${config.seller.address}` : ""}{config.seller.gstin ? ` · GSTIN ${config.seller.gstin}` : ""}.</> : null}</span>
              <span><a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a> · <a href="/legal/data-processing">Data processing</a> · <a href="/legal/subprocessors">Subprocessors</a> · <a href="/legal/accessibility">Accessibility</a></span>
            </div>
          </div>
        </footer>
        <dialog class="command-dialog" data-command-dialog aria-labelledby="command-title">
          <div class="command-head"><h2 id="command-title">Go to a page</h2><button type="button" class="btn ghost sm" data-command-close>Close</button></div>
          <label class="sr-only" for="command-query">Search pages</label><input id="command-query" type="search" placeholder="Search pages…" autocomplete="off" />
          <nav class="command-results" aria-label="Page search">{palette.map(([h, l]) => <a href={h}><Icon name="arrow" /><span>{l}</span></a>)}</nav>
          <p class="command-empty" hidden>No matching pages. Try another name.</p>
          <div class="command-foot">Press Escape to close.</div>
        </dialog>
        {p.quiet ? null : (
          <div id="lbt-chat" data-staffed={staffed ? "1" : "0"} data-wa={waLink()} data-phone={CONTACT.phoneDisplay} data-tel={CONTACT.tel} data-email={CONTACT.emails.support} data-from={config.contact.chatFromHour} data-to={config.contact.chatToHour} data-tz={config.contact.chatTz} data-csrf={p.csrf}></div>
        )}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
          "@context": "https://schema.org", "@type": "Organization", name: "LOAD|BY|TON.store", url: config.baseUrl, logo: new URL("/brand/lbt-logo-navy.png", config.baseUrl).href,
          contactPoint: [{ "@type": "ContactPoint", telephone: config.contact.phone, email: config.contact.emails.contact, contactType: "sales", availableLanguage: ["English", "Arabic"] }, { "@type": "ContactPoint", email: config.contact.emails.support, contactType: "customer support" }],
        }) }} />
      </body>
    </html>
  );
};

export interface NavItem { href: string; label: string; section?: string }

const initials = (n: string) => (n || "?").split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase();

/** Shared frame for the workspace and the control console: pill navigation, icon rail, command search, alerts, account menu, status bar. */
function DeskFrame({ p, nav, area, tenantName, roles, banner, switcher, rail, pills, children }: {
  p: Page; nav: NavItem[]; area: "workspace" | "control"; tenantName: string; roles: string[]; banner?: Child; switcher?: Child;
  rail: { href: string; label: string; icon: string; id?: string; active: boolean; items?: NavItem[] }[]; pills: { href: string; label: string; icon?: string; active: boolean }[]; children: Child;
}) {
  const home = area === "workspace" ? "/app" : "/admin";
  const crumbs = rail.find((r) => r.active && r.items);
  return (
    <html lang="en" data-surface="desk">
      <Head p={p} surface="desk" />
      <body class={`desk ${area === "control" ? "control-desk" : "workspace-experience"}`}>
        <a class="skip" href="#main">Skip to content</a>
        <div class="desk-frame">
          <header class="topbar no-print">
            <a class="brand" href={home} aria-label={area === "control" ? "LOAD|BY|TON control console" : "LOAD|BY|TON workspace home"}>
              <img class="logo-light" src="/brand/lbt-logo-navy.png" alt="" width="110" height="30" />
              <img class="logo-dark" src="/brand/lbt-logo-white.png" alt="" width="110" height="30" />
              <span class="os">{area === "control" ? "CONSOLE" : "OS"}</span>
            </a>
            <nav class="primary-pills" aria-label="Primary">
              {pills.map((x) => <a class={`primary-pill${x.active ? " active" : ""}`} href={x.href} aria-current={x.active ? "page" : undefined}>{x.icon ? <Icon name={x.icon} size={15} /> : null}{x.label}</a>)}
            </nav>
            <div class="tb-spacer"></div>
            {area === "workspace" ? (
              <div class="pop">
                <button class="tb" type="button" data-pop-toggle data-alerts aria-haspopup="true" aria-expanded="false" aria-label="Alerts"><Icon name="bell" /><span class="count" data-alert-count></span></button>
                <div class="popover" data-pop hidden>
                  <header><b>Needs attention</b><span class="grow"></span><a class="small" href="/app">Dashboard</a></header>
                  <div class="list"><div class="empty">Loading…</div></div>
                  <footer>Overdue invoices, due exceptions, delayed milestones and document holds.</footer>
                </div>
              </div>
            ) : null}
            <button class="tb" type="button" data-command-open hidden aria-label="Find a page"><Icon name="search" /><span class="lbl">Search</span><kbd>Ctrl K</kbd></button>
            <button class="tb" type="button" data-theme-toggle hidden aria-label="Switch light or dark theme" aria-pressed="false"><Icon name="moon" /></button>
            <div class="pop">
              <button class="me-chip" type="button" data-pop-toggle aria-haspopup="true" aria-expanded="false"><i>{initials(p.user?.name ?? "")}</i><span class="lbl">{(p.user?.name ?? "").split(" ")[0]}</span></button>
              <div class="popover" data-pop hidden>
                <header><div data-notranslate><b>{p.user?.name}</b><br /><span class="small mute">{roles.join(", ")}</span></div></header>
                <div class="list" style="padding:14px 18px;display:grid;gap:10px">
                  {tenantName ? <span class="tenant-chip" data-notranslate><i></i>{tenantName}</span> : null}
                  {switcher}
                  <a href="/account/security" class="btn ghost sm"><Icon name="lock" size={16} />Account security</a>
                  <span class="small" data-notranslate><a href={`/lang/ar?next=${encodeURIComponent(p.path)}`}>العربية</a> · <a href={`/lang/en?next=${encodeURIComponent(p.path)}`}>English</a></span>
                  <form method="post" action="/logout"><Csrf t={p.csrf} /><button class="btn sm red" type="submit"><Icon name="logout" size={16} />Sign out</button></form>
                </div>
              </div>
            </div>
          </header>
          {banner}
          <div class="desk-row">
            {rail.length > 1 ? (
              <nav class="workspace-rail no-print" aria-label="Workspace shortcuts">
                {rail.map((r) => (
                  <a class={`rail-shortcut${r.active ? " active" : ""}`} href={r.href} data-workspace-open={r.items ? `ws-${r.id}` : undefined} aria-current={r.active ? "page" : undefined} title={r.label}>
                    <Icon name={r.icon} /><span class="rail-shortcut-label">{r.label}</span>
                  </a>
                ))}
              </nav>
            ) : <div></div>}
            <main id="main" class="app-main">
              <div class="section-navigation no-print">
                <a class="section-back" href={home} data-back><Icon name="arrowLeft" size={16} />Back</a>
                <nav class="workspace-breadcrumb" aria-label="Breadcrumb"><a href={home}><Icon name="home" size={15} />{area === "control" ? "Console" : "Workspace"}</a>{crumbs && crumbs.id !== "home" ? <><Icon name="chevron" size={13} /><a href={crumbs.href}>{crumbs.label}</a></> : null}<Icon name="chevron" size={13} /><span class="cur">{p.title}</span></nav>
              </div>
              <Flash ok={p.ok} err={p.err} />
              {children}
            </main>
          </div>
          <footer class="statusbar no-print">
            <span class="live">Signed in</span><span data-notranslate>{p.user?.name}</span>
            <span data-clock data-notranslate></span>
            <span class="grow"></span>
            <span>Help:</span><span data-notranslate><a href={CONTACT.tel}>{CONTACT.phoneDisplay}</a> · <a href={waLink()} target="_blank" rel="noopener">WhatsApp</a> · <a href={`mailto:${CONTACT.emails.support}`}>{CONTACT.emails.support}</a></span>
            <span><Lbt /> {area === "control" ? "control console" : "OS"}</span>
          </footer>
        </div>
        <dialog class="command-dialog" data-command-dialog aria-labelledby="command-title">
          <div class="command-head"><h2 id="command-title">Go to a page</h2><button type="button" class="btn ghost sm" data-command-close>Close</button></div>
          <label class="sr-only" for="command-query">Search pages</label><input id="command-query" type="search" placeholder="Search pages…" autocomplete="off" />
          <nav class="command-results" aria-label="Page search">{nav.map((n) => <a href={n.href}><Icon name="arrow" /><span>{n.label}<small>{n.section || (area === "control" ? "Console" : "Workspace")}</small></span></a>)}</nav>
          <p class="command-empty" hidden>No matching pages. Try another name.</p>
          <div class="command-foot">Search the pages available to your role. Escape to close.</div>
        </dialog>
        {rail.filter((r) => r.items).map((r) => (
          <dialog class="workspace-popup" id={`ws-${r.id}`} aria-labelledby={`ws-${r.id}-t`}>
            <div class="sheet">
              <button class="sheet-x" type="button" data-close aria-label="Close" style="color:var(--ink);background:var(--soft)">×</button>
              <h2 id={`ws-${r.id}-t`}>{r.label}</h2>
              <p class="mute">{SECTION_BLURB[r.label] ?? "Choose a task below."}</p>
              <nav class="workspace-menu-links" aria-label={r.label}>{r.items!.map((i) => <a href={i.href}><span>{i.label}</span><Icon name="chevron" size={18} /></a>)}</nav>
              <a class="btn red" href={r.href}><span>Open</span> <span>{r.label}</span><Icon name="arrow" size={16} /></a>
            </div>
          </dialog>
        ))}
      </body>
    </html>
  );
}

export const AppShell = ({ p, nav, tenantName, roles, banner, children, switcher }: {
  p: Page; nav: NavItem[]; tenantName: string; roles: string[]; banner?: string; children: Child; switcher?: Child;
}) => {
  const activeHref = nav.filter((n) => p.path === n.href || (n.href !== "/app" && p.path.startsWith(n.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const activeSection = nav.find((n) => n.href === activeHref)?.section ?? "";
  const sections = [...new Set(nav.map((n) => n.section ?? "").filter(Boolean))];
  const rail = nav.length > 1 ? [
    { href: "/app", label: "Home", icon: "home", id: "home", active: p.path === "/app" },
    ...sections.map((s) => ({ href: `/app/workspaces/${slugOf(s)}`, label: s, icon: SECTION_ICON[s] ?? "grid", id: slugOf(s), active: activeSection === s && p.path !== "/app", items: nav.filter((n) => n.section === s) })),
  ] : [];
  const hasReports = nav.some((n) => n.href === "/app/reports");
  const pills = nav.length > 1 ? [
    { href: "/app", label: "Dashboard", icon: "gauge", active: p.path === "/app" },
    { href: "/app/workspaces", label: "Workspaces", icon: "grid", active: p.path.startsWith("/app/workspaces") },
    ...(hasReports ? [{ href: "/app/reports", label: "Reports", icon: "chart", active: p.path.startsWith("/app/reports") }] : []),
  ] : [];
  return (
    <DeskFrame p={p} nav={nav} area="workspace" tenantName={tenantName} roles={roles} switcher={switcher} rail={rail} pills={pills}
      banner={banner ? <div class="banner" role="status">{banner}</div> : undefined}>{children}</DeskFrame>
  );
};

export const ADMIN_NAV: [string, string, string][] = [["/admin", "Overview", "gauge"], ["/admin/tenants", "Tenants", "people"], ["/admin/orders", "Orders & payments", "money"], ["/admin/provisioning", "Provisioning", "bolt"],
  ["/admin/catalog", "Catalog & prices", "tag"], ["/admin/queues", "Queues & reviews", "layers"], ["/admin/service", "Setup & privacy", "lock"], ["/admin/partners", "Partners", "users"], ["/admin/rollout", "Rollout", "route"],
  ["/admin/reports", "Reports", "chart"], ["/admin/readiness", "Readiness", "shield"], ["/admin/einvoice", "E-invoicing", "shield"], ["/admin/leads", "Leads", "mail"], ["/admin/chats", "Live chats", "chat"]];

export const AdminShell = ({ p, children }: { p: Page; children: Child }) => {
  const navItems = ADMIN_NAV.map(([href, label]) => ({ href, label }));
  const rail = ADMIN_NAV.map(([href, label, icon]) => ({ href, label, icon, active: p.path === href || (href !== "/admin" && p.path.startsWith(href + "/")) }));
  const pills = [["/admin", "Overview", "gauge"], ["/admin/tenants", "Tenants", "people"], ["/admin/orders", "Orders", "money"], ["/admin/chats", "Live chats", "chat"]].map(([href, label, icon]) => ({ href, label, icon, active: p.path === href || (href !== "/admin" && p.path.startsWith(href + "/")) }));
  return (
    <DeskFrame p={p} nav={navItems} area="control" tenantName="Platform control" roles={["platform staff"]} rail={rail} pills={pills}
      banner={<div class="control-banner" role="status">Platform control console — privileged surface. All actions are audited.</div>}>{children}</DeskFrame>
  );
};

export const sectorName = (slug: string) => SECTORS.find((s) => s.slug === slug)?.name ?? slug;

export function Table({ head, children, caption, empty }: { head: (string | [string, string])[]; children: Child; caption?: string; empty?: string }) {
  return (
    <div class="tbl-wrap">
      <table>
        {caption ? <caption>{caption}</caption> : null}
        <thead><tr>{head.map((h) => (Array.isArray(h) ? <th class={h[1]}>{h[0]}</th> : <th>{h}</th>))}</tr></thead>
        <tbody>{children}</tbody>
      </table>
      {empty ? <p class="mute" style="padding:12px 16px;margin:0">{empty}</p> : null}
    </div>
  );
}

export { B };
