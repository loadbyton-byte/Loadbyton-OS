import type { Conn, Db } from "../db/client.js";
import { validateWafeqCredentials, wafeqAdapter, wafeqEnvironment } from "../adapters/einvoice-wafeq.js";
import type { EInvoiceAdapter } from "../adapters/einvoice.js";
import { audit } from "../lib/audit.js";
import { decryptSecret, encryptSecret } from "../lib/encryption.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, forbidden } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";

/**
 * E-invoicing as a paid add-on. A workspace asks for it (Not activated → Onboarding); platform staff — after the client has paid and the provider account
 * is ready — attach the provider, the client's taxpayer reference and credentials, set the document allowance, and switch it Active. The provider API key
 * is stored encrypted and is only ever written by staff; no screen shows it again. Live submission needs Active; Sandbox testing is possible while Onboarding.
 */
export type ServiceState = "not_activated" | "onboarding" | "active" | "suspended";

/** Allowances are documents per period. Prices are agreed with the client outside this system; nothing here sets or implies one. */
export const PACKAGES: { key: string; label: string; docs: number }[] = [
  { key: "start", label: "Start — up to 500 documents a year", docs: 500 },
  { key: "growth", label: "Growth — up to 1,500 documents a year", docs: 1500 },
  { key: "scale", label: "Scale — up to 5,000 documents a year", docs: 5000 },
];

/** Providers whose adapter is installed. Others (Aigentrix, Marmin) are added here once their adapter exists and the partner terms are agreed. */
export const SERVICE_PROVIDERS: Record<string, { label: string; validate(c: Record<string, any>): Record<string, any>; environment(c: Record<string, any>): "sandbox" | "live"; taxpayerRef(c: Record<string, any>): string; build(c: Record<string, any>, f?: typeof fetch): EInvoiceAdapter }> = {
  wafeq: {
    label: "Wafeq",
    validate: (c) => validateWafeqCredentials(c),
    environment: (c) => wafeqEnvironment(String(c.apiKey)),
    taxpayerRef: (c) => String(c.taxpayerId),
    build: (c, f) => wafeqAdapter(validateWafeqCredentials(c), f),
  },
};

export interface ServiceRow { tenant_id: string; state: ServiceState; package: string | null; provider: string | null; environment: "sandbox" | "live"; taxpayer_ref: string | null; allowance_docs: number | null; used_docs: number; period_ends: string | null; payment_note: string | null }
const IDLE = { state: "not_activated" as ServiceState, package: null, provider: null, environment: "sandbox" as const, taxpayer_ref: null, allowance_docs: null, used_docs: 0, period_ends: null, payment_note: null };

export async function getService(c: Conn): Promise<ServiceRow> {
  return ((await c.query<any>(`SELECT * FROM einvoice_service`)).rows[0] ?? IDLE) as ServiceRow;
}

/** The workspace asks for the add-on. Staff take it from here; the workspace cannot activate itself. */
export async function requestActivation(c: Conn, ctx: Ctx, pkg: string) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  const p = PACKAGES.find((x) => x.key === pkg);
  if (!p) throw badRequest("Choose one of the e-invoicing packages.");
  const cur = await getService(c);
  if (cur.state === "active" || cur.state === "suspended") throw badRequest("E-invoicing is already set up for this workspace. Ask support to change it.");
  await c.query(
    `INSERT INTO einvoice_service(tenant_id,state,package,requested_by,requested_at) VALUES ($1,'onboarding',$2,$3,now())
     ON CONFLICT (tenant_id) DO UPDATE SET state='onboarding', package=$2, requested_by=$3, requested_at=now(), updated_at=now()`,
    [ctx.tenantId, p.key, ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "einvoice.activation_requested", "tenant", ctx.tenantId, { package: p.key });
}

// ───────── platform staff
export type Staff = { userId: string; role: string };
const CONFIGURERS = ["commercial_admin", "engineer", "support"], ACTIVATORS = ["commercial_admin", "engineer"];
const text = (v: unknown, max = 200) => { const t = String(v ?? "").trim(); return t ? t.slice(0, max) : null; };

/** Attach or change the provider, taxpayer, credentials and allowance for a workspace. Credentials are replaced only when new ones are supplied. */
export async function staffConfigure(db: Db, s: Staff, tenantId: string, f: Record<string, any>) {
  if (!CONFIGURERS.includes(s.role)) throw forbidden("Your staff role cannot configure e-invoicing.");
  const provider = text(f.provider, 40) ?? "", def = SERVICE_PROVIDERS[provider];
  if (!def) throw badRequest("Choose a provider whose adapter is installed.");
  const allowance = f.allowance_docs === undefined || f.allowance_docs === "" || f.allowance_docs === null ? null : Number(f.allowance_docs);
  if (allowance !== null && (!Number.isInteger(allowance) || allowance < 0 || allowance > 10_000_000)) throw badRequest("The allowance is a whole number of documents, or blank for no limit.");
  const periodEnds = text(f.period_ends, 10);
  if (periodEnds && !/^\d{4}-\d{2}-\d{2}$/.test(periodEnds)) throw badRequest("The period end is a date.");
  return db.system(async (c) => {
    if (!(await c.query(`SELECT 1 FROM tenants WHERE id=$1`, [tenantId])).rows.length) throw new HttpError(404, "Unknown workspace");
    const existing = (await c.query<any>(`SELECT * FROM einvoice_credentials WHERE tenant_id=$1`, [tenantId])).rows[0];
    const newCreds = text(f.api_key) || text(f.taxpayer_id);
    let environment: "sandbox" | "live" = "sandbox", taxpayerRef: string | null = null;
    if (newCreds || !existing) {
      let creds: Record<string, any>;
      try { creds = def.validate({ apiKey: f.api_key, taxpayerId: f.taxpayer_id, baseUrl: f.base_url }); } catch (e: any) { throw badRequest(e.message); }
      environment = def.environment(creds); taxpayerRef = def.taxpayerRef(creds);
      await c.query(
        `INSERT INTO einvoice_credentials(tenant_id,provider,credentials_enc,updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id) DO UPDATE SET provider=$2, credentials_enc=$3, updated_by=$4, updated_at=now()`, [tenantId, provider, encryptSecret(JSON.stringify(creds)), s.userId]);
    } else {
      if (existing.provider !== provider) throw badRequest("Changing the provider needs that provider's credentials.");
      const keep = (await c.query<any>(`SELECT environment, taxpayer_ref FROM einvoice_service WHERE tenant_id=$1`, [tenantId])).rows[0];
      environment = keep?.environment ?? "sandbox"; taxpayerRef = keep?.taxpayer_ref ?? null;
    }
    await c.query(
      `INSERT INTO einvoice_service(tenant_id,state,provider,environment,taxpayer_ref,allowance_docs,period_ends,payment_note) VALUES ($1,'onboarding',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id) DO UPDATE SET provider=$2, environment=$3, taxpayer_ref=$4, allowance_docs=$5, period_ends=$6, payment_note=coalesce($7,einvoice_service.payment_note),
         state=CASE WHEN einvoice_service.state='not_activated' THEN 'onboarding' ELSE einvoice_service.state END, updated_at=now()`,
      [tenantId, provider, environment, taxpayerRef, allowance, periodEnds, text(f.payment_note, 300)]);
    await audit(c, tenantId, { kind: "platform_staff", userId: s.userId }, "einvoice.service_configured", "tenant", tenantId, { provider, environment, credentialsReplaced: !!newCreds || !existing });
  });
}

/** Activation is a commercial act: the client has paid (recorded) and the provider account exists. Suspension stops submissions without deleting anything. */
export async function staffSetState(db: Db, s: Staff, tenantId: string, state: "onboarding" | "active" | "suspended", reason: string) {
  if (!ACTIVATORS.includes(s.role)) throw forbidden("Activating or suspending e-invoicing is done by a commercial administrator or an engineer.");
  if (!["onboarding", "active", "suspended"].includes(state)) throw badRequest("Unknown state.");
  const why = text(reason, 300); if (!why) throw badRequest("Give the reason or the payment reference.");
  return db.system(async (c) => {
    const row = (await c.query<any>(`SELECT * FROM einvoice_service WHERE tenant_id=$1 FOR UPDATE`, [tenantId])).rows[0];
    if (!row) throw badRequest("This workspace has not asked for, or been set up for, e-invoicing.");
    if (state === "active") {
      if (!row.provider || !row.taxpayer_ref) throw badRequest("Attach the provider, taxpayer and credentials before activating.");
      if (!(await c.query(`SELECT 1 FROM einvoice_credentials WHERE tenant_id=$1`, [tenantId])).rows.length) throw badRequest("Provider credentials are missing.");
    }
    await c.query(`UPDATE einvoice_service SET state=$2, payment_note=CASE WHEN $2='active' THEN $3 ELSE payment_note END, activated_by=CASE WHEN $2='active' THEN $4::uuid ELSE activated_by END,
        activated_at=CASE WHEN $2='active' THEN now() ELSE activated_at END, updated_at=now() WHERE tenant_id=$1`, [tenantId, state, why, s.userId]);
    await audit(c, tenantId, { kind: "platform_staff", userId: s.userId }, `einvoice.service_${state}`, "tenant", tenantId, { from: row.state, reason: why });
  });
}

/** Everything staff see on one screen: workspaces that have asked for, or hold, the service. Never any credential. */
export async function staffListServices(db: Db) {
  return (await db.query<any>(`SELECT s.tenant_id, t.name AS workspace, s.state, s.package, s.provider, s.environment, s.taxpayer_ref, s.allowance_docs, s.used_docs, s.period_ends, s.payment_note, s.requested_at, s.activated_at,
      EXISTS (SELECT 1 FROM einvoice_credentials k WHERE k.tenant_id=s.tenant_id) AS has_credentials
    FROM einvoice_service s JOIN tenants t ON t.id=s.tenant_id ORDER BY CASE s.state WHEN 'onboarding' THEN 0 WHEN 'active' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, s.requested_at DESC NULLS LAST LIMIT 200`)).rows;
}

// ───────── routing a submission
export interface Route { adapter: EInvoiceAdapter; service: ServiceRow; environment: "sandbox" | "live" }

/**
 * The provider route for this workspace, or null when it has none (the older single-provider settings then apply).
 * A route exists while Onboarding in Sandbox, and while Active. Live traffic needs Active; a suspended service routes nowhere.
 */
export async function routeFor(c: Conn, fetchImpl?: typeof fetch, readOnly = false): Promise<Route | null> {
  const service = (await c.query<any>(`SELECT * FROM einvoice_service${readOnly ? "" : " FOR UPDATE"}`)).rows[0] as ServiceRow | undefined;
  if (!service || !service.provider) return null;
  if (service.state === "not_activated") return null;
  if (!readOnly) {                                       // reading a document's state stays possible while suspended; sending does not
    if (service.state === "suspended") throw forbidden("E-invoicing is suspended for this workspace. Contact support.");
    if (service.state === "onboarding" && service.environment === "live") throw forbidden("Live e-invoicing starts once support has activated it. You can test in Sandbox meanwhile.");
  }
  const def = SERVICE_PROVIDERS[service.provider];
  const cred = (await c.query<any>(`SELECT credentials_enc FROM einvoice_credentials`)).rows[0];
  if (!def || !cred) throw forbidden("The e-invoicing provider is not fully set up for this workspace yet.");
  return { adapter: def.build(JSON.parse(decryptSecret(cred.credentials_enc)), fetchImpl), service, environment: service.environment };
}

/** Allowance check before sending, and one unit spent after the provider took the document (live traffic only). */
export function assertAllowance(r: Route) {
  const { allowance_docs: a, used_docs: u } = r.service;
  if (r.environment === "live" && a !== null && u >= a) throw badRequest("This workspace has used its e-invoicing allowance. Ask support to add documents.");
}
export async function spendAllowance(c: Conn, r: Route) {
  if (r.environment !== "live") return;
  await c.query(`SELECT einvoice_consume_allowance()`);
}
