import type { Child } from "hono/jsx";
import { Icon, WorkspaceTools } from "./experience.js";
import { config } from "../config.js";
import { fmtMoney } from "../lib/util.js";
import { SECTORS } from "../platform/catalog.js";

export interface Page {
  title: string; csrf: string; path: string; description?: string;
  ok?: string; err?: string; user?: { name: string } | null; head?: Child;
  offlineScope?: string;
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
    {ok ? <div class="alert ok" role="status"><strong>Done.</strong> {ok}</div> : null}
    {err ? <div class="alert err" role="alert"><strong>Problem.</strong> {err}</div> : null}
  </>
);

function Head({ p }: { p: Page }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{p.title} · LOAD|BY|TON.store</title>
      <meta name="description" content={p.description ?? "Your logistics company, connected. Start free, choose the tools your business needs, and run enquiries, jobs, documents, deliveries and collections from one branded workspace."} />
      <meta name="theme-color" content="#0F2B3D" />
      <meta name="csrf-token" content={p.csrf} />
      {p.offlineScope?<meta name="driver-scope" content={p.offlineScope}/>:null}
      <link rel="icon" href="/brand/favicon.ico" sizes="any" />
      <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" sizes="180x180" />
      {!p.path.startsWith("/app/driver") ? <link rel="manifest" href="/brand/site.webmanifest" /> : null}
      {!p.path.startsWith("/app") && !p.path.startsWith("/admin") ? <>
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="LOAD|BY|TON.store" />
        <meta property="og:title" content={p.title + " · LOAD|BY|TON.store"} />
        <meta property="og:image" content={new URL("/brand/exports/templates/open-graph.png", config.baseUrl).href} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="LOAD|BY|TON.store — Run the movement. Know the margin." />
        <meta name="twitter:card" content="summary_large_image" />
      </> : null}
      <link rel="stylesheet" href="/assets/app.css" />
      <link rel="stylesheet" href="/brand/design-tokens.css" />
      <link rel="stylesheet" href="/assets/experience.css" />
      <script src="/assets/app.js" defer></script>
      {p.path.startsWith("/app/driver") ? <link rel="manifest" href="/app/driver/manifest.webmanifest" /> : null}
      {p.path.startsWith("/app/driver") ? <script src="/assets/driver.js" defer></script> : null}
      {p.head ?? null}
    </head>
  );
}

const PUBLIC_NAV: [string, string][] = [
  ["/sectors", "Sectors"], ["/products", "Products"], ["/find-my-bundle", "Find my bundle"], ["/pricing", "Pricing"],
  ["/how-activation-works", "How it works"], ["/enterprise", "Enterprise"], ["/security", "Security"],
];

export const PublicShell = ({ p, children }: { p: Page; children: Child }) => (
  <html lang="en">
    <Head p={p} />
    <body class="public-experience">
      <a class="skip" href="#main">Skip to content</a>
      <header class="site-head">
        <div class="wrap">
          <a class="brand" href="/" aria-label="LOAD|BY|TON.store home"><img src="/brand/logo-navy.svg" alt="LOAD|BY|TON.store" width="170" height="34" /></a>
          <button class="site-menu-toggle btn ghost sm" type="button" data-site-menu aria-expanded="false" aria-controls="public-navigation" hidden>Menu</button>
          <nav class="nav" id="public-navigation" aria-label="Main">
            {PUBLIC_NAV.map(([h, l]) => <a href={h} aria-current={p.path === h || (h !== "/" && p.path.startsWith(h + "/")) ? "page" : undefined}>{l}</a>)}
            {p.user ? <a class="btn sm" href="/app">Open workspace</a> : (
              <>
                <a href="/login">Sign in</a>
                <a class="btn red sm" href="/start">Start free</a>
              </>
            )}
          </nav>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer class="site">
        <div class="wrap grid g4">
          <div>
            <img src="/brand/logo-silver.svg" alt="LOAD|BY|TON.store" width="170" height="34" />
            <p class="small" style="margin-top:12px">Run the movement. Know the margin.</p>
          </div>
          <div><h4>Product</h4><ul><li><a href="/products">Products</a></li><li><a href="/sectors">Sectors</a></li><li><a href="/pricing">Pricing &amp; plans</a></li><li><a href="/integrations">Integrations</a></li><li><a href="/enterprise">Enterprise controls</a></li></ul></div>
          <div><h4>Company</h4><ul><li><a href="/contact">Contact</a></li><li><a href="/coverage">Service coverage</a></li><li><a href="/stories">Customer stories</a></li><li><a href="/resources">Resources</a></li><li><a href="/status">Service status</a></li></ul></div>
          <div><h4>Legal</h4><ul><li><a href="/legal/terms">Terms</a></li><li><a href="/legal/privacy">Privacy</a></li><li><a href="/legal/data-processing">Data processing</a></li><li><a href="/legal/subprocessors">Subprocessors</a></li><li><a href="/legal/accessibility">Accessibility</a></li></ul></div>
        </div>
        <div class="wrap small" style="margin-top:24px">© LOAD|BY|TON.store · Logistics software and services for UAE logistics companies.
          {config.seller.legalName ? <> Operated by {config.seller.legalName}{config.seller.address ? `, ${config.seller.address}` : ""}{config.seller.gstin ? ` · GSTIN ${config.seller.gstin}` : ""}{config.seller.email ? ` · ${config.seller.email}` : ""}.</> : null}</div>
      </footer>
    </body>
  </html>
);

export interface NavItem { href: string; label: string; section?: string }

export const AppShell = ({ p, nav, tenantName, roles, banner, children, switcher }: {
  p: Page; nav: NavItem[]; tenantName: string; roles: string[]; banner?: string; children: Child; switcher?: Child;
}) => {
  const sections = [...new Set(nav.map((n) => n.section ?? ""))];
  const activeHref = nav.filter(n => p.path === n.href || (n.href !== '/app' && p.path.startsWith(n.href + '/')))
    .sort((a,b) => b.href.length - a.href.length)[0]?.href;
  return (
    <html lang="en">
      <Head p={p} />
      <body class="workspace-experience">
        <a class="skip" href="#main">Skip to content</a>
        {banner ? <div class="banner" role="status">{banner}</div> : null}
        <div class="shell">
          <aside class="side" id="workspace-sidebar">
            <a class="brand" href="/app"><img src="/brand/logo-silver.svg" alt="LOAD|BY|TON.store" width="190" height="38" /></a>
            <div class="tenant-label"><span class="tenant-indicator"></span>{tenantName}</div>
            <nav aria-label="Workspace">
              {sections.map((s) => (
                <>
                  {s ? <h4>{s}</h4> : null}
                  {nav.filter((n) => (n.section ?? "") === s).map((n) => (
                    <a href={n.href} aria-current={n.href === activeHref ? "page" : undefined}><Icon name={n.section === "Money" ? "money" : n.section === "Admin" ? "shield" : n.section === "Transport" ? "truck" : n.section === "Operate" ? "document" : "grid"} /><span>{n.label}</span></a>
                  ))}
                </>
              ))}
            </nav>
            <div class="me">
              {p.user?.name}<br /><span class="small">{roles.join(", ")}</span>
              {switcher}
              <form method="post" action="/logout" style="margin-top:8px"><Csrf t={p.csrf} /><button class="btn ghost sm" style="color:#fff;border-color:#8EA3BA" type="submit">Sign out</button></form>
              <p class="small" style="margin-top:10px" data-notranslate><a href={`/lang/ar?next=${encodeURIComponent(p.path)}`} style="color:#D7E0EA">العربية</a> · <a href={`/lang/en?next=${encodeURIComponent(p.path)}`} style="color:#D7E0EA">English</a></p>
            </div>
          </aside>
          <main id="main" class="main">
            <WorkspaceTools title={p.title} tenantName={tenantName} nav={nav} />
            <Flash ok={p.ok} err={p.err} />
            {children}
          </main>
        </div>
      </body>
    </html>
  );
};

export const AdminShell = ({ p, children }: { p: Page; children: Child }) => {
  const nav: [string, string][] = [["/admin", "Overview"], ["/admin/tenants", "Tenants"], ["/admin/orders", "Orders & payments"], ["/admin/provisioning", "Provisioning"],
    ["/admin/catalog", "Catalog & prices"], ["/admin/queues", "Queues & reviews"], ["/admin/service", "Setup & privacy"], ["/admin/partners", "Partners"], ["/admin/rollout", "Rollout"], ["/admin/reports", "Reports"], ["/admin/readiness", "Readiness"], ["/admin/leads", "Leads"]];
  return (
    <html lang="en">
      <Head p={p} />
      <body class="workspace-experience control-experience">
        <a class="skip" href="#main">Skip to content</a>
        <div class="banner" style="background:#FDECEE;border-color:var(--red);color:#7C0C15">Platform control console — privileged surface. All actions are audited.</div>
        <div class="shell">
          <aside class="side" id="workspace-sidebar">
            <a class="brand" href="/admin"><img src="/brand/logo-silver.svg" alt="LOAD|BY|TON.store" width="190" height="38" /></a>
            <nav aria-label="Control console">{nav.map(([h, l]) => <a href={h} aria-current={p.path === h || (h !== "/admin" && p.path.startsWith(h + "/")) ? "page" : undefined}><Icon name="shield" /><span>{l}</span></a>)}</nav>
            <div class="me">{p.user?.name}
              <form method="post" action="/logout" style="margin-top:8px"><Csrf t={p.csrf} /><button class="btn ghost sm" style="color:#fff;border-color:#8EA3BA" type="submit">Sign out</button></form>
            </div>
          </aside>
          <main id="main" class="main"><WorkspaceTools title={p.title} tenantName="Platform control" nav={nav.map(([href,label]) => ({href,label}))} /><Flash ok={p.ok} err={p.err} />{children}</main>
        </div>
      </body>
    </html>
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
