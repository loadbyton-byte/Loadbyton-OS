import type { Db, Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { ROLES, actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, checkPasswordStrength, hashPassword, randomToken, sha256,verifyPassword } from "../lib/util.js";
import {encryptSecret} from '../lib/encryption.js';
import {rateLimit} from '../adapters/rate-limit.js';
import { assertCapacity, getLimit } from "../platform/entitlements.js";
import { optStr } from "./common.js";

export const listTeam = (c: Conn) => c.query<any>(`SELECT * FROM team_members ORDER BY name`).then((r) => r.rows);

function cleanRoles(r: unknown): string[] {
  const arr = (Array.isArray(r) ? r : [r]).map(String).filter((x) => (ROLES as readonly string[]).includes(x));
  if (!arr.length) throw badRequest("Choose at least one role.");
  return [...new Set(arr)];
}

/** Individual accounts only: an invitation carries no password; the invitee sets their own. */
export async function invite(c: Conn, ctx: Ctx, f: { email: string; roles: unknown; party_id?: string; driver_id?: string }) {
  require(ctx, "team.manage");
  const email = String(f.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Enter a valid email address.");
  if((await c.query(`SELECT 1 FROM team_members WHERE email=$1 AND active`,[email])).rows.length)throw new HttpError(409,'This account already belongs to the workspace. Change its roles in Team.');
  const roles = cleanRoles(f.roles);
  if(roles.includes('portal')&&roles.length>1)throw badRequest('A portal seat is limited and cannot be combined with other roles.');
  if (roles.includes("owner") && !ctx.roles.includes("owner")) throw badRequest("Only an owner can invite another owner.");
  const limited = roles.includes("portal") || roles.includes("driver");
  if (roles.includes("driver")) {
    if (roles.length > 1) throw badRequest("A driver seat is limited and cannot be combined with other roles.");
    if (!f.driver_id) throw badRequest("Driver users must be linked to a driver record.");
    const taken = await c.query(`SELECT 1 FROM memberships WHERE driver_id=$1 AND active`, [f.driver_id]);
    if (taken.rows.length) throw badRequest("That driver already has a login.");
    // driver seats are separate from full-user seats but not unlimited: at most 5 per full-user allowance
    const n = Number((await c.query<any>(`SELECT count(*) n FROM memberships WHERE active AND 'driver' = ANY(roles)`)).rows[0].n);
    if (n >= 5 * (await getLimit(c, ctx.tenantId, "max_users"))) throw badRequest("Driver seat allowance reached for this plan.");
  }
  if (!limited) await assertCapacity(c, ctx.tenantId, "max_users");
  if (roles.includes("portal") && !f.party_id) throw badRequest("Portal users must be linked to a customer.");
  const token = randomToken(32);
  await c.query(
    `INSERT INTO invitations(tenant_id,email,roles,party_id,driver_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days',$7)`,
    [ctx.tenantId, email, roles, optStr(f.party_id, 40), roles.includes("driver") ? f.driver_id : null, sha256(token), ctx.userId]);
  await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3) ON CONFLICT (key) DO NOTHING`,
    [ctx.tenantId, `invite:${sha256(token)}`, JSON.stringify({ template: "invitation", email,tokenEncrypted:encryptSecret(token) })]);
  await audit(c, ctx.tenantId, actorOf(ctx), "team.invited", "invitation", undefined, { email, roles });
  return token;
}

export async function inviteInfo(db: Db, token: string) {
  const r = await db.query<any>(
    `SELECT i.*, t.name AS tenant_name FROM invitations i JOIN tenants t ON t.id=i.tenant_id
     WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.expires_at > now()`, [sha256(token)]);
  return r.rows[0] ?? null;
}

export async function acceptInvite(db: Db, token: string, f: { name: string; password: string }) {
  const inv = await inviteInfo(db, token);
  if (!inv) throw new HttpError(410, "This invitation is invalid or has expired.", "gone");
  await rateLimit(`invitation:${inv.email}`,8);
  return db.system(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`team:${inv.tenant_id}`]);
    const active=(await c.query<any>(`SELECT * FROM invitations WHERE id=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE`,[inv.id])).rows[0];
    if(!active)throw new HttpError(410,'This invitation was already accepted or expired');
    const creator=(await c.query<any>(`SELECT roles FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active`,[inv.tenant_id,inv.created_by])).rows[0];
    if(!creator||!['owner','hr'].some(r=>creator.roles.includes(r))||(inv.roles.includes('owner')&&!creator.roles.includes('owner')))throw new HttpError(403,'The invitation is no longer authorized by its issuer');
    let user = (await c.query<any>(`SELECT id,password_hash FROM users WHERE email=$1`, [inv.email])).rows[0];
    if(user&&!await verifyPassword(f.password,user.password_hash))throw new HttpError(401,'Enter the existing account password to accept this invitation');
    const membership=user?(await c.query<any>(`SELECT roles,active FROM memberships WHERE tenant_id=$1 AND user_id=$2`,[inv.tenant_id,user.id])).rows[0]:null;
    if(membership?.active)throw new HttpError(409,'You already belong to this workspace. An owner can change your roles in Team.');
    if(!inv.roles.includes('portal')&&!inv.roles.includes('driver')) {
      await dbCapacity(c,inv.tenant_id);
    }
    if (!user) {
      checkPasswordStrength(f.password);
      if (!String(f.name ?? "").trim()) throw badRequest("Enter your name.");
      user = (await c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id`, [inv.email, f.name.trim(), await hashPassword(f.password)])).rows[0];
    }
    await c.query(
      `INSERT INTO memberships(tenant_id,user_id,roles,party_id,driver_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id,user_id) DO UPDATE SET roles=EXCLUDED.roles, active=true, party_id=EXCLUDED.party_id, driver_id=EXCLUDED.driver_id`,
      [inv.tenant_id, user.id, inv.roles, inv.party_id, inv.driver_id]);
    if (inv.driver_id) await c.query(`UPDATE drivers SET user_id=$2 WHERE id=$1`, [inv.driver_id, user.id]);
    await c.query(`UPDATE invitations SET accepted_at=now() WHERE id=$1 AND accepted_at IS NULL`, [inv.id]);
    await audit(c, inv.tenant_id, { kind: "user", userId: user.id }, "team.joined", "user", user.id);
    return { userId: user.id, tenantId: inv.tenant_id };
  });
}

export async function setRoles(c: Conn, ctx: Ctx, userId: string, roles: unknown) {
  require(ctx, "team.manage");
  const rs = cleanRoles(roles);
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`team:${ctx.tenantId}`]);
  if(rs.includes('portal')&&rs.length>1)throw badRequest('A portal seat cannot be combined with staff roles');
  if(rs.includes('owner')&&!ctx.roles.includes('owner'))throw badRequest('Only an owner can grant owner access');
  const current=(await c.query<any>(`SELECT roles FROM memberships WHERE user_id=$1`,[userId])).rows[0];
  if(current?.roles.includes('owner')&&!ctx.roles.includes('owner'))throw badRequest('Only an owner can modify another owner');
  if(current?.roles.includes('portal')&&!rs.includes('portal'))await assertCapacity(c,ctx.tenantId,'max_users');
  if (rs.includes("driver")) throw badRequest("Driver seats are created from Transport → Fleet & drivers.");
  const cur = (await c.query<any>(`SELECT driver_id FROM memberships WHERE user_id=$1`, [userId])).rows[0];
  if (cur?.driver_id) throw badRequest("This is a driver seat; manage it under Transport → Fleet & drivers.");
  const owners = (await c.query<any>(`SELECT user_id FROM memberships WHERE active AND 'owner' = ANY(roles)`)).rows;
  if (owners.length === 1 && owners[0].user_id === userId && !rs.includes("owner")) throw badRequest("A workspace must keep at least one owner.");
  await c.query(`UPDATE memberships SET roles=$2 WHERE user_id=$1`, [userId, rs]);
  await audit(c, ctx.tenantId, actorOf(ctx), "team.roles_changed", "user", userId, { roles: rs });
}

export async function deactivate(c: Conn, ctx: Ctx, userId: string) {
  require(ctx, "team.manage");
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`team:${ctx.tenantId}`]);
  const owners = (await c.query<any>(`SELECT user_id FROM memberships WHERE active AND 'owner' = ANY(roles)`)).rows;
  if (owners.length === 1 && owners[0].user_id === userId) throw badRequest("A workspace must keep at least one owner.");
  if(owners.some(o=>o.user_id===userId)&&!ctx.roles.includes('owner'))throw badRequest('Only an owner can deactivate another owner');
  await c.query(`UPDATE memberships SET active=false WHERE user_id=$1`, [userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "team.deactivated", "user", userId);
}

async function dbCapacity(c:Conn,tenantId:string) {
 const status=(await c.query<any>(`SELECT status FROM subscriptions WHERE tenant_id=$1`,[tenantId])).rows[0]?.status;
 if(['restricted','cancelled'].includes(status))throw new HttpError(402,'Workspace is read-only');
 const used=Number((await c.query<any>(`SELECT count(*) n FROM memberships WHERE tenant_id=$1 AND active AND NOT ('portal'=ANY(roles)) AND NOT ('driver'=ANY(roles))`,[tenantId])).rows[0].n);
 const limit=await getLimit(c,tenantId,'max_users');if(used>=limit)throw new HttpError(402,'Full user allowance reached');
}
