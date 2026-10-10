import type { Child } from "hono/jsx";
import { fmtMoney } from "../lib/util.js";
import { SECTORS } from "../platform/catalog.js";

export interface Page {
  title: string; csrf: string; path: string; description?: string;
  ok?: string; err?: string; user?: { name: string } | null;
}

export const Money = ({ v, cur = "AED" }: { v: number | string; cur?: string }) => <span class="nowrap">{fmtMoney(v, cur)}</span>;

const BADGE: Record<string, string> = {
  pilot: "warn", planned: "info", available: "ok", live: "ok", paid: "ok", active: "ok", approved: "ok", converted: "ok", accepted: "ok", delivered: "ok",
  operationally_complete: "ok", collected: "ok", closed: "ok", synced: "ok", resolved: "ok", ready: "ok", onboarding: "ok", won: "ok", verified: "ok", sent: "info",
  pending: "warn", pending_approval: "warn", draft: "info", open: "warn", invoiced: "info", issued: "info", part_paid: "warn", grace: "warn",
  qualified: "info", new: "info", quoted: "info", queued: "info", provisioning: "info", validation: "info", information_pending: "warn", in_transit: "info", planned_job: "info",
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
      <meta name="theme-color" content="#071D35" />
      <link rel="icon" href="/brand/favicon.ico" sizes="any" />
      <link rel="apple-touch-icon" href="/brand/by-mark-192.png" />
      <link rel="stylesheet" href="/assets/app.css" />
      <script src="/assets/app.js" defer></script>
    </head>
  );
}

const PUBLIC_NAV: [string, string][] = [
  ["/sectors", "Sectors"], ["/products", "Products"], ["/find-my-bundle", "Find my bundle"], ["/pricing", "Pricing"],
  ["/how-activation-works", "How it works"], ["/security", "Security"], ["/help", "Help"],
];

export const PublicShell = ({ p, children }: { p: Page; children: Child }) => (
  <html lang="en">
    <Head p={p} />
    <body>
      <a class="skip" href="#main">Skip to content</a>
      <header class="site-head">
        <div class="wrap">
          <a class="brand" href="/" aria-label="LOAD|BY|TON.store home"><img src="/brand/logo-navy.png" alt="LOAD|BY|TON.store" width="120" height="37" /></a>
          <nav class="nav" aria-label="Main">
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
            <img src="/brand/logo-silver.png" alt="LOAD|BY|TON.store" width="170" height="52" />
            <p class="small" style="margin-top:12px">Run the movement. Know the margin.</p>
          </div>
          <div><h4>Product</h4><ul><li><a href="/products">Products</a></li><li><a href="/sectors">Sectors</a></li><li><a href="/pricing">Pricing &amp; plans</a></li><li><a href="/integrations">Integrations</a></li></ul></div>
          <div><h4>Company</h4><ul><li><a href="/contact">Contact</a></li><li><a href="/coverage">Service coverage</a></li><li><a href="/stories">Customer stories</a></li><li><a href="/resources">Resources</a></li><li><a href="/status">Service status</a></li></ul></div>
          <div><h4>Legal</h4><ul><li><a href="/legal/terms">Terms</a></li><li><a href="/legal/privacy">Privacy</a></li><li><a href="/legal/data-processing">Data processing</a></li><li><a href="/legal/subprocessors">Subprocessors</a></li><li><a href="/legal/accessibility">Accessibility</a></li></ul></div>
        </div>
        <div class="wrap small" style="margin-top:24px">© LOAD|BY|TON.store · Logistics software and services for UAE logistics companies.</div>
      </footer>
    </body>
  </html>
);

export interface NavItem { href: string; label: string; section?: string }

export const AppShell = ({ p, nav, tenantName, roles, banner, children, switcher }: {
  p: Page; nav: NavItem[]; tenantName: string; roles: string[]; banner?: string; children: Child; switcher?: Child;
}) => {
  const sections = [...new Set(nav.map((n) => n.section ?? ""))];
  return (
    <html lang="en">
      <Head p={p} />
      <body>
        <a class="skip" href="#main">Skip to content</a>
        {banner ? <div class="banner" role="status">{banner}</div> : null}
        <div class="shell">
          <aside class="side">
            <a class="brand" href="/app"><img src="/brand/logo-silver.png" alt="LOAD|BY|TON.store" width="190" height="58" /></a>
            <div style="padding:0 20px 8px;font-weight:700">{tenantName}</div>
            <nav aria-label="Workspace">
              {sections.map((s) => (
                <>
                  {s ? <h4>{s}</h4> : null}
                  {nav.filter((n) => (n.section ?? "") === s).map((n) => (
                    <a href={n.href} aria-current={p.path === n.href || (n.href !== "/app" && p.path.startsWith(n.href)) ? "page" : undefined}>{n.label}</a>
                  ))}
                </>
              ))}
            </nav>
            <div class="me">
              {p.user?.name}<br /><span class="small">{roles.join(", ")}</span>
              {switcher}
              <form method="post" action="/logout" style="margin-top:8px"><Csrf t={p.csrf} /><button class="btn ghost sm" style="color:#fff;border-color:#8EA3BA" type="submit">Sign out</button></form>
            </div>
          </aside>
          <main id="main" class="main">
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
    ["/admin/catalog", "Catalog & prices"], ["/admin/queues", "Queues & reviews"], ["/admin/leads", "Leads"]];
  return (
    <html lang="en">
      <Head p={p} />
      <body>
        <div class="banner" style="background:#FDECEE;border-color:var(--red);color:#7C0C15">Platform control console — privileged surface. All actions are audited.</div>
        <div class="shell">
          <aside class="side">
            <a class="brand" href="/admin"><img src="/brand/logo-silver.png" alt="LOAD|BY|TON.store" width="190" height="58" /></a>
            <nav aria-label="Control console">{nav.map(([h, l]) => <a href={h} aria-current={p.path === h || (h !== "/admin" && p.path.startsWith(h)) ? "page" : undefined}>{l}</a>)}</nav>
            <div class="me">{p.user?.name}
              <form method="post" action="/logout" style="margin-top:8px"><Csrf t={p.csrf} /><button class="btn ghost sm" style="color:#fff;border-color:#8EA3BA" type="submit">Sign out</button></form>
            </div>
          </aside>
          <main id="main" class="main"><Flash ok={p.ok} err={p.err} />{children}</main>
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
