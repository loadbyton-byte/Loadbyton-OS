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
  if (ctx.roles.length === 1 && ctx.roles[0] === "driver") return [{ href: "/app/driver", label: "My trips" }];
  const t = c.get("tenant");
  const fwd = t?.sectors.includes("freight-forwarding");
  const n: NavItem[] = [{ href: "/app", label: "Overview" }];
  if (fwd) {
    n.push({ href: "/app/enquiries", label: "Enquiries", section: "Sell" }, { href: "/app/quotes", label: "Quotations", section: "Sell" });
  }
  if (t?.sectors.includes("road-transport")) {
    n.push({ href: "/app/transport", label: "Planning board", section: "Transport" }, { href: "/app/transport/orders", label: "Transport orders", section: "Transport" },
      { href: "/app/transport/trips", label: "Trips", section: "Transport" }, { href: "/app/transport/fleet", label: "Fleet & drivers", section: "Transport" });
  }
  n.push({ href: "/app/parties", label: "Customers & suppliers", section: "Sell" });
  if (fwd) n.push({ href: "/app/rates", label: "Supplier rates", section: "Sell" },
    { href: "/app/jobs", label: "Jobs", section: "Operate" });
  n.push({ href: "/app/documents", label: "Documents", section: "Operate" });
  if (fwd) n.push({ href: "/app/tasks", label: "Tasks & exceptions", section: "Operate" },
    { href: "/app/invoices", label: "Invoices & collections", section: "Money" });
  if (ctx.perms.has("dashboard.owner")) n.push({ href: "/app/reports", label: "Owner dashboard", section: "Money" });
  if (ctx.perms.has("team.manage")) n.push({ href: "/app/team", label: "Team", section: "Admin" });
  if (ctx.perms.has("billing.manage")) n.push({ href: "/app/billing", label: "Plan & billing", section: "Admin" });
  if (ctx.perms.has("settings.manage")) n.push({ href: "/app/settings", label: "Settings", section: "Admin" });
  if (ctx.perms.has("audit.read")) n.push({ href: "/app/audit", label: "Audit trail", section: "Admin" });
  return n;
}

export function appPage(c: C, title: string, body: Child, extra: Partial<Page> = {}) {
  const ctx = ctxOf(c), s = c.get("session")!, t = c.get("tenant")!;
  const p: Page = { title, csrf: c.get("csrf"), path: c.req.path, user: { name: s.name }, ok: c.req.query("ok"), err: c.req.query("err"), ...extra };
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
