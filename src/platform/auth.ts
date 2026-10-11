import type { Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { permsFor, type Ctx } from "../lib/perms.js";
import { HttpError, hashPassword, randomToken, sha256, verifyPassword, verifyTotp, totp } from "../lib/util.js";
import { rateLimit, resetRateLimits } from "../adapters/rate-limit.js";

const SESSION_HOURS = 12;
// verifying against a dummy hash keeps unknown-email timing close to wrong-password timing
let dummyHash: string | null = null;

export interface Session {
  token: string; userId: string; tenantId: string | null; csrf: string; mfaOk: boolean; companyMfaOk: boolean; supportTenantId: string | null;
  isStaff: boolean; staffRole: string | null; name: string; email: string;
}

export async function newSession(db: Db, userId: string, tenantId: string | null, mfaOk = false) {
  const token = randomToken(32), csrf = randomToken(16);
  await db.query(
    `INSERT INTO sessions(token_hash,user_id,tenant_id,csrf,mfa_ok,expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' hours')::interval)`,
    [sha256(token), userId, tenantId, csrf, mfaOk, String(SESSION_HOURS)]);
  return { token, csrf };
}

export async function loadSession(db: Db, token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const r = await db.query<any>(
    `SELECT s.*, u.name, u.email, ps.role AS staff_role, ps.active AS staff_active FROM sessions s JOIN users u ON u.id=s.user_id
     LEFT JOIN platform_staff ps ON ps.user_id=u.id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)]);
  const s = r.rows[0];
  if (!s) return null;
  return {
    token, userId: s.user_id, tenantId: s.tenant_id, csrf: s.csrf, mfaOk: s.mfa_ok, companyMfaOk: s.company_mfa_ok, supportTenantId: s.support_tenant_id,
    isStaff: !!s.staff_role && s.staff_active, staffRole: s.staff_role, name: s.name, email: s.email,
  };
}

export async function endSession(db: Db, token: string) {
  await db.query(`UPDATE sessions SET revoked_at=now() WHERE token_hash=$1`, [sha256(token)]);
}
export async function revokeAllSessions(db: Db, userId: string) {
  await db.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
}

export const resetThrottle = resetRateLimits;

export async function login(db: Db, email: string, password: string, ip = "") {
  const e = email.trim().toLowerCase();
  // Per-IP budget across all emails stops spraying. There is deliberately no per-account cap: it would let anyone lock a known user out.
  await rateLimit(`login-ip:${ip}`,40);
  await rateLimit(`login:${e}|${ip}`);
  const u = (await db.query<any>(`SELECT id,password_hash FROM users WHERE email=$1`, [e])).rows[0];
  dummyHash ??= await hashPassword("dummy-password-for-timing");
  const ok = await verifyPassword(password, u?.password_hash ?? dummyHash);
  if (!u || !ok) throw new HttpError(401, "Email or password is incorrect.", "unauthorized");
  const staff = (await db.query<any>(`SELECT 1 FROM platform_staff WHERE user_id=$1 AND active`, [u.id])).rows.length > 0;
  const mem = (await db.query<any>(
    `SELECT m.tenant_id FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.active AND t.status='active' ORDER BY m.created_at`, [u.id])).rows;
  const tenantId = mem[0]?.tenant_id ?? null;
  const s = await newSession(db, u.id, tenantId, false);
  await db.system((c) => audit(c, tenantId, { kind: "user", userId: u.id }, "auth.login", "user", u.id));
  return { ...s, userId: u.id, staff };
}

/** Platform staff must complete TOTP before the session can reach the control console. */
export async function completeMfa(db: Db, token: string, code: string) {
  const s = await loadSession(db, token);
  if (!s || !s.isStaff) throw new HttpError(403, "Not a platform staff account.", "forbidden");
  const st = (await db.query<any>(`SELECT totp_secret FROM platform_staff WHERE user_id=$1`, [s.userId])).rows[0];
  await rateLimit(`mfa|${s.userId}`);
  if (!verifyTotp(st.totp_secret, code)) throw new HttpError(401, "That code is not valid.", "unauthorized");
  const steps=[-1,0,1].map(w=>Math.floor(Date.now()/30000)+w);
  // Consume exactly the matching timestep; the same code cannot authorize another session.
  const matching=steps.find(n=>totp(st.totp_secret,n*30000)===code.trim());
  if(matching===undefined || !(await db.query(`UPDATE platform_staff SET last_totp_step=$2 WHERE user_id=$1 AND last_totp_step<$2 RETURNING user_id`,[s.userId,matching])).rows.length) throw new HttpError(401,'This code was already used. Wait for the next code.');
  await db.query(`UPDATE sessions SET mfa_ok=true WHERE token_hash=$1`, [sha256(token)]);
  await db.system((c) => audit(c, null, { kind: "platform_staff", userId: s.userId }, "staff.mfa_ok"));
}

export async function membershipsFor(db: Db, userId: string) {
  return (await db.query<any>(
    `SELECT m.tenant_id, m.roles, t.name, t.slug FROM memberships m JOIN tenants t ON t.id=m.tenant_id
     WHERE m.user_id=$1 AND m.active AND t.status='active' ORDER BY t.name`, [userId])).rows;
}

export async function switchTenant(db: Db, token: string, userId: string, tenantId: string) {
  const m = (await membershipsFor(db, userId)).find((x) => x.tenant_id === tenantId);
  if (!m) throw new HttpError(403, "You are not a member of that workspace.", "forbidden");
  await db.query(`UPDATE sessions SET tenant_id=$2, support_tenant_id=NULL WHERE token_hash=$1`, [sha256(token), tenantId]);
}

/**
 * Tenant identity is derived from authenticated membership (or an approved, unexpired support grant),
 * never from a client-supplied tenant id. An optional hostname hint may only *select among* the user's own tenants.
 */
export async function resolveCtx(db: Db, s: Session, hostSlug?: string | null): Promise<Ctx | null> {
  let tenantId = s.tenantId;
  if (hostSlug) {
    const m = (await membershipsFor(db, s.userId)).find((x) => x.slug === hostSlug);
    if(m)tenantId=m.tenant_id;
    else if(!s.supportTenantId)return null;
  }
  if (s.supportTenantId && s.isStaff && s.mfaOk) {
    if(hostSlug) {
      const target=(await db.query<any>(`SELECT slug FROM tenants WHERE id=$1`,[s.supportTenantId])).rows[0];
      if(target?.slug!==hostSlug)return null;
    }
    const g = (await db.query<any>(
      `SELECT 1 FROM support_grants WHERE tenant_id=$1 AND staff_user_id=$2 AND status='approved' AND expires_at > now()`, [s.supportTenantId, s.userId])).rows;
    if (!g.length) return null;
    return { userId: s.userId, tenantId: s.supportTenantId, roles: ["auditor"], perms: permsFor(["auditor"]), partyId: null, driverId: null, readOnly: true, supportStaffId: s.userId };
  }
  if (!tenantId) return null;
  const m = (await db.query<any>(`SELECT roles, party_id, driver_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active`, [tenantId, s.userId])).rows[0];
  if (!m) return null;
  const t = (await db.query<any>(`SELECT status FROM tenants WHERE id=$1`, [tenantId])).rows[0];
  if (!t || t.status !== "active") return null;
  return { userId: s.userId, tenantId, roles: m.roles, perms: permsFor(m.roles), partyId: m.party_id, driverId: m.driver_id, readOnly: false, supportStaffId: null };
}
