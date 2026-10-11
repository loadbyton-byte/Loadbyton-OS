import {SPECIALIST_PROFILES} from "../ops/specialist-profiles.js";
import {sectorBySlug} from "../platform/catalog.js";
import type { Child } from "hono/jsx";
import type { Conn } from "../db/client.js";
import { HttpError } from "../lib/util.js";
import type { Ctx, Perm } from "../lib/perms.js";
import { require as requirePerm } from "../lib/perms.js";
import { AppShell, Csrf, type NavItem, type Page } from "./ui.js";
import type { C } from "./mw.js";

export const ctxOf = (c: C): Ctx => c.get("ctx")!;

/** Run fn inside a tenant-scoped transaction for the authenticated context. */
export function withT<T>(c: C, fn: (cn: Conn, ctx: Ctx) => Promise<T>): Promise<T> {
  const ctx = ctxOf(c);
  return c.get("db").tenant(ctx.tenantId, (cn) => fn(cn, ctx));
}

export function can(c: C, perm: Perm) { return ctxOf(c).perms.has(perm); }
export function need(c: C, perm: Perm) { requirePerm(ctxOf(c), perm); }

export function navFor(c: C): NavItem[] {
  const ctx = ctxOf(c);
  if (ctx.roles.length === 1 && ctx.roles[0] === "portal") return [{ href: "/app/portal", label: "My shipments" }];
  if (ctx.roles.length === 1 && ctx.roles[0] === "driver") return [{ href: "/app/driver", label: "My work" }];
  const t = c.get("tenant");
  const fwd = t?.sectors.includes("freight-forwarding");
  const n: NavItem[] = [{ href: "/app", label: "Overview" }];
  if (fwd) {
    n.push({ href: "/app/enquiries", label: "Enquiries", section: "Sell" }, { href: "/app/quotes", label: "Quotations", section: "Sell" });
  }
  if (t?.sectors.includes("customs-brokerage")) n.push({href:"/app/customs",label:"Customs cases",section:"Customs"});
  if (t?.sectors.includes("courier-last-mile")) n.push({href:"/app/delivery",label:"Delivery & COD",section:"Delivery"});
  if (t?.sectors.includes("road-transport")) {
    n.push({ href: "/app/transport", label: "Planning board", section: "Transport" }, { href: "/app/transport/orders", label: "Transport orders", section: "Transport" },
      { href: "/app/transport/trips", label: "Trips", section: "Transport" }, { href: "/app/transport/fleet", label: "Fleet & drivers", section: "Transport" }, { href: "/app/transport/live", label: "Live trips", section: "Transport" }, { href: "/app/transport/feeds", label: "Fuel & Salik", section: "Transport" });
  }
  if (t?.sectors.includes("ecommerce-fulfilment")) {
    const w = (href: string, label: string) => n.push({ href, label, section: "Fulfilment" });
    w("/app/fulfilment", "Fulfilment board"); w("/app/fulfilment/orders", "Orders"); w("/app/fulfilment/pick", "Pick list"); w("/app/fulfilment/inbound", "Inbound");
    w("/app/fulfilment/stock", "Stock"); w("/app/fulfilment/returns", "Returns"); w("/app/fulfilment/catalog", "Catalogue"); w("/app/fulfilment/locations", "Locations");
    if (ctx.perms.has("wh.rates") || ctx.perms.has("finance.write")) {w("/app/fulfilment/billing", "Billing activity");w('/app/fulfilment/daily-storage','Daily storage');}
  }
  if (t?.sectors.includes("contract-warehouse-3pl")) {
    n.push({ href: "/app/warehouse", label: "Warehouse board", section: "Warehouse" }, { href: "/app/warehouse/inbound", label: "Inbound", section: "Warehouse" },
      { href: "/app/warehouse/outbound", label: "Dispatch", section: "Warehouse" }, { href: "/app/warehouse/stock", label: "Stock", section: "Warehouse" },
      { href: "/app/warehouse/counts", label: "Counts", section: "Warehouse" }, { href: "/app/warehouse/setup", label: "Locations & SKUs", section: "Warehouse" }, {href:"/app/warehouse/traceability",label:"Lots, expiry & serials",section:"Warehouse"});
    n.push({href:'/app/warehouse/count-schedules',label:'Count schedules',section:'Warehouse'},{href:'/app/warehouse/returns',label:'Customer returns',section:'Warehouse'},{href:'/app/warehouse/policy',label:'Custody policy',section:'Warehouse'},{href:'/app/warehouse/labels',label:'Labels',section:'Warehouse'},{href:'/app/warehouse/rf',label:'Handheld',section:'Warehouse'});
    if (ctx.perms.has("wh.bill")) n.push({ href: "/app/warehouse/billing", label: "Activity billing", section: "Warehouse" });
  }
  for(const s of t?.sectors??[]) if(SPECIALIST_PROFILES[s]) n.push({href:`/app/specialists/${s}`,label:sectorBySlug(s)!.name,section:"Specialist cases"});
  if(t?.sectors.includes('cold-chain')&&ctx.perms.has('specialist.write'))n.push({href:'/app/cold-chain/devices',label:'Temperature loggers',section:'Specialist cases'});
  if (t?.sectors.includes("courier-last-mile")) {
    const w = (href: string, label: string) => n.push({ href, label, section: "Delivery" });
    w("/app/delivery", "Delivery board"); w("/app/delivery/shipments", "Parcels"); w("/app/delivery/runs", "Runs"); w("/app/delivery/riders", "Riders"); w("/app/delivery/cash", "Cash desk");
    if (ctx.perms.has("dlv.bill")) w("/app/delivery/billing", "Rates & billing");
    if (ctx.perms.has("settings.manage")) w("/app/delivery/integrations", "Integrations");
  }
  if (t?.sectors.includes("customs-brokerage")) {
    const w = (href: string, label: string) => n.push({ href, label, section: "Customs" });
    w("/app/customs", "Customs board"); w("/app/customs/cases", "Cases");
    if (ctx.perms.has("cus.cash")) w("/app/customs/deposits", "Deposits & guarantees");
  }
  n.push({ href: "/app/parties", label: "Customers & suppliers", section: "Sell" });
  if (fwd) n.push({ href: "/app/rates", label: "Supplier rates", section: "Sell" },
    { href: "/app/jobs", label: "Jobs", section: "Operate" });
  if (fwd && ctx.perms.has('quote.write')) n.push({href:'/app/freight/weight',label:'Chargeable weight',section:'Sell'});
  if (fwd) n.push({ href: "/app/freight/opportunities", label: "Opportunities & tenders", section: "Sell" }, { href: "/app/freight/contracts", label: "Supplier contracts", section: "Sell" }, { href: "/app/freight/masters", label: "Master shipments", section: "Operate" });
  n.push({ href: "/app/documents", label: "Documents", section: "Operate" });
  if (ctx.perms.has("doc.write")) n.push({ href: "/app/extractions", label: "Document extraction", section: "Operate" });
  if (t && t.sectors.length) n.push({ href: "/app/tasks", label: "Tasks & exceptions", section: "Operate" },
    { href: "/app/invoices", label: "Invoices & collections", section: "Money" });
  if (t && t.sectors.length && ctx.perms.has("finance.write")) n.push({ href: "/app/finance/credit-notes", label: "Credit notes", section: "Money" }, { href: "/app/finance/payables", label: "Supplier bills", section: "Money" }, { href: "/app/finance/fx", label: "Exchange rates", section: "Money" }, { href: "/app/einvoice", label: "E-invoicing readiness", section: "Money" }, { href: "/app/settings/feeds", label: "Statement feeds", section: "Money" });
  if (fwd && ctx.perms.has("dashboard.owner")) n.push({ href: "/app/reports", label: "Owner dashboard", section: "Money" });   // job-margin view: freight only
  if (ctx.perms.has("team.manage")) n.push({ href: "/app/team", label: "Team", section: "Admin" });
  if (ctx.perms.has("billing.manage")) n.push({ href: "/app/billing", label: "Plan & billing", section: "Admin" });
  if (ctx.perms.has("settings.manage")) n.push({ href: "/app/settings", label: "Settings", section: "Admin" });
  if (ctx.perms.has("settings.manage")) n.push({href:'/app/connections',label:'Accounting connection',section:'Admin'});
  if (ctx.perms.has("settings.manage")) n.push({href:'/app/privacy',label:'Your data',section:'Admin'});
  if (ctx.perms.has("settings.manage")) n.push({href:'/app/onboarding',label:'Setup and onboarding',section:'Admin'});
  if (ctx.perms.has("settings.manage")) n.push({href:'/app/api-keys',label:'API keys',section:'Admin'});
  if(ctx.perms.has('inbox.write'))n.push({href:'/app/inbox',label:'Shared inbox',section:'Operate'},{href:'/app/inbox-unmatched',label:'Unmatched messages',section:'Operate'});
  if(ctx.perms.has('settings.manage'))n.push({href:'/app/inbox-channels',label:'Inbound channels',section:'Admin'});
  if(fwd&&(ctx.perms.has('enquiry.write')||ctx.perms.has('job.write')))n.push({href:'/app/assistant',label:'Assistant drafts',section:'Operate'});
  if(fwd&&(ctx.perms.has('job.write')||ctx.perms.has('job.cost')))n.push({href:'/app/document-drafts',label:'Document drafts',section:'Operate'},{href:'/app/document-drafts/versions',label:'Template versions',section:'Operate'});
  if(ctx.perms.has('dashboard.owner'))n.push({href:'/app/management-reports',label:'Management reports',section:'Money'});
  if(ctx.perms.has('settings.manage'))n.push({href:'/app/migration',label:'Migration and calendar',section:'Admin'});
  n.push({href:'/account/security',label:'Account security',section:'Admin'});
  if (ctx.perms.has("audit.read")) n.push({ href: "/app/audit", label: "Audit trail", section: "Admin" });
  return n;
}

export function appPage(c: C, title: string, body: Child, extra: Partial<Page> = {}) {
  const ctx = ctxOf(c), s = c.get("session")!, t = c.get("tenant")!;
  const p: Page = { title, csrf: c.get("csrf"), path: c.req.path, user: { name: s.name }, offlineScope: ctx.perms.has('driver.act')?`${ctx.tenantId}:${ctx.userId}`:undefined, ok: c.req.query("ok"), err: c.req.query("err"), ...extra };
  const mems = c.get("memberships");
  const switcher = mems.length > 1 ? (
    <form method="post" action="/app/switch" style="margin-top:8px">
      <Csrf t={p.csrf} />
      <label for="sw" class="small" style="color:#B9C7D6">Workspace</label>
      <select id="sw" name="tenant_id" data-autosubmit>{mems.map((m) => <option value={m.tenant_id} selected={m.tenant_id === ctx.tenantId}>{m.name}</option>)}</select>
      <button class="btn ghost sm" style="color:#fff;border-color:#8EA3BA;margin-top:6px" type="submit">Switch</button>
    </form>
  ) : null;
  return c.html(
    <AppShell p={p} nav={navFor(c)} tenantName={t.name} roles={ctx.roles}
      banner={ctx.readOnly ? "Support access: read-only, time-limited, audited under your identity." : t.subStatus === "grace" ? "Payment overdue — your workspace enters read-only mode when the grace period ends." : t.subStatus === "restricted" ? "Workspace is read-only until the subscription is restored. You can still read and export everything." : undefined}
      switcher={switcher}>
      {body}
    </AppShell>,
  );
}

export const msg = (s: string) => encodeURIComponent(s);
export function back(c: C, to: string, ok?: string, err?: string) {
  const u = new URL(to, "http://x");
  if (ok) u.searchParams.set("ok", ok);
  if (err) u.searchParams.set("err", err);
  return c.redirect(u.pathname + u.search);
}

/** Run a mutation: success → redirect with ok; known errors → redirect back with the message (never a stack). */
export async function act(c: C, failTo: string, fn: () => Promise<{ to: string; ok?: string } | Response>) {
  try {
    const r = await fn();
    if (r instanceof Response) return r;
    return back(c, r.to, r.ok);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return back(c, failTo, undefined, e.message);
    throw e;
  }
}

export const PageHead = ({ title, children, sub }: { title: string; children?: Child; sub?: string }) => (
  <header class="page">
    <div><h1>{title}</h1>{sub ? <p class="mute small" style="margin:.2em 0 0">{sub}</p> : null}</div>
    <div class="spacer"></div>
    <div class="no-print inline-form">{children}</div>
  </header>
);

export const Confirm = ({ action, csrf, label, confirm, cls = "danger sm", fields }: { action: string; csrf: string; label: string; confirm: string; cls?: string; fields?: Record<string, string> }) => (
  <form method="post" action={action} data-confirm={confirm} class="inline">
    <Csrf t={csrf} />
    {fields ? Object.entries(fields).map(([k, v]) => <input type="hidden" name={k} value={v} />) : null}
    <button class={`btn ${cls}`} type="submit">{label}</button>
  </form>
);

export const PostBtn = ({ action, csrf, label, cls = "sm", fields }: { action: string; csrf: string; label: string; cls?: string; fields?: Record<string, string> }) => (
  <form method="post" action={action} class="inline">
    <Csrf t={csrf} />
    {fields ? Object.entries(fields).map(([k, v]) => <input type="hidden" name={k} value={v} />) : null}
    <button class={`btn ${cls}`} type="submit">{label}</button>
  </form>
);
