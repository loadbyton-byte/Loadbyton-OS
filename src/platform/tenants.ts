import type { Db, Conn } from "../db/client.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import {
  HttpError, RESERVED_SLUGS, badRequest, checkPasswordStrength, hashPassword, randomToken, slugify,
} from "../lib/util.js";
import { applyPlanEntitlements, getLimit } from "./entitlements.js";
import { currentPlans, ensureCatalog, sectorBySlug } from "./catalog.js";

export interface RegisterInput {
  company: string; contactName: string; email: string; password: string; country?: string;
  emirate?: string; sectors?: string[]; goal?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function reserveSlug(c: Conn, base: string): Promise<string> {
  let slug = slugify(base);
  if (RESERVED_SLUGS.has(slug)) slug = `${slug}-co`;
  for (let i = 0; i < 50; i++) {
    const cand = i === 0 ? slug : `${slug}-${i + 1}`;
    const r = await c.query(`SELECT 1 FROM tenants WHERE slug=$1`, [cand]);
    if (!r.rows.length) return cand;
  }
  return `${slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

export const standardHostname = (slug: string) =>
  config.rootDomain ? `${slug}.${config.rootDomain}` : `${slug}.localhost`;

/** Register once → empty real workspace on the permanent Free plan. Demo data lives elsewhere. */
export async function registerCompany(db: Db, input: RegisterInput) {
  const email = input.email.trim().toLowerCase();
  if (!input.company.trim()) throw badRequest("Company name is required.");
  if (!input.contactName.trim()) throw badRequest("Contact name is required.");
  if (!EMAIL_RE.test(email)) throw badRequest("Enter a valid email address.");
  checkPasswordStrength(input.password);
  const pwHash = await hashPassword(input.password);

  return db.system(async (c) => {
    await ensureCatalog(c);
    const exists = await c.query(`SELECT 1 FROM users WHERE email=$1`, [email]);
    if (exists.rows.length) throw new HttpError(409, "An account with this email already exists. Sign in instead.", "conflict");

    const free = (await currentPlans(c)).find((p) => p.plan_code === "free")!;
    const user = (await c.query<{ id: string }>(
      `INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id`, [email, input.contactName.trim(), pwHash])).rows[0];
    const slug = await reserveSlug(c, input.company);
    const tenant = (await c.query<{ id: string }>(
      `INSERT INTO tenants(slug,name,country,emirate,goal) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [slug, input.company.trim(), input.country || "AE", input.emirate || null, input.goal || null])).rows[0];
    const t = tenant.id;

    await c.query(`INSERT INTO entities(tenant_id,name) VALUES ($1,$2)`, [t, input.company.trim()]);
    await c.query(`INSERT INTO memberships(tenant_id,user_id,roles) VALUES ($1,$2,$3)`, [t, user.id, ["owner"]]);
    await c.query(`INSERT INTO subscriptions(tenant_id,plan_version_id,status,period_end) VALUES ($1,$2,'active',NULL)`, [t, free.id]);
    await applyPlanEntitlements(c, t, free, "registration");
    await c.query(
      `INSERT INTO domain_mappings(tenant_id,hostname,kind,status,verify_token,verified_at) VALUES ($1,$2,'standard','verified',$3,now())`,
      [t, standardHostname(slug), randomToken(12)]);

    // sectors: up to the plan's allowance become selected sectors; the rest are recorded as interest
    const wanted = [...new Set((input.sectors ?? []).filter((s) => sectorBySlug(s)))];
    const allowed = free.limits.max_sectors;
    for (const s of wanted.slice(0, allowed)) await c.query(`INSERT INTO tenant_sectors(tenant_id,sector) VALUES ($1,$2)`, [t, s]);
    if (wanted.length > allowed) {
      await c.query(`INSERT INTO platform_leads(name,company,email,sectors,source,message) VALUES ($1,$2,$3,$4,'registration-interest','Sectors beyond Free allowance')`,
        [input.contactName, input.company, email, wanted.slice(allowed)]);
    }
    await audit(c, t, { kind: "user", userId: user.id }, "tenant.registered", "tenant", t, { slug, sectors: wanted });
    return { userId: user.id, tenantId: t, slug };
  });
}

export async function tenantSummary(c: Conn, tenantId: string) {
  const t = await c.query(`SELECT * FROM tenants WHERE id=$1`, [tenantId]);
  return t.rows[0];
}

export async function setSectors(c: Conn, tenantId: string, sectors: string[], actorId: string) {
  const picked = [...new Set(sectors.filter((s) => sectorBySlug(s)))];
  const limit = await getLimit(c, tenantId, "max_sectors");
  if (picked.length > limit) throw new HttpError(402, `Your plan includes ${limit} sector(s). Upgrade to select more.`, "quota_exceeded");
  await c.query(`DELETE FROM tenant_sectors WHERE tenant_id=$1`, [tenantId]);
  for (const s of picked) await c.query(`INSERT INTO tenant_sectors(tenant_id,sector) VALUES ($1,$2)`, [tenantId, s]);
  await audit(c, tenantId, { kind: "user", userId: actorId }, "tenant.sectors_set", "tenant", tenantId, { sectors: picked });
}
