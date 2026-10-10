import type { Db, Conn } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { ROLES, actorOf, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, checkPasswordStrength, hashPassword, randomToken, sha256 } from "../lib/util.js";
import { assertCapacity } from "../platform/entitlements.js";
import { optStr } from "./common.js";

export const listTeam = (c: Conn) => c.query<any>(`SELECT * FROM team_members ORDER BY name`).then((r) => r.rows);

function cleanRoles(r: unknown): string[] {
  const arr = (Array.isArray(r) ? r : [r]).map(String).filter((x) => (ROLES as readonly string[]).includes(x));
  if (!arr.length) throw badRequest("Choose at least one role.");
  return [...new Set(arr)];
}

/** Individual accounts only: an invitation carries no password; the invitee sets their own. */
export async function invite(c: Conn, ctx: Ctx, f: { email: string; roles: unknown; party_id?: string }) {
  require(ctx, "team.manage");
  const roles = cleanRoles(f.roles);
  if (roles.includes("owner") && !ctx.roles.includes("owner")) throw badRequest("Only an owner can invite another owner.");
  if (!roles.includes("portal")) await assertCapacity(c, ctx.tenantId, "max_users");
  if (roles.includes("portal") && !f.party_id) throw badRequest("Portal users must be linked to a customer.");
  const email = String(f.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Enter a valid email address.");
  const token = randomToken(32);
  await c.query(
    `INSERT INTO invitations(tenant_id,email,roles,party_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days',$6)`,
    [ctx.tenantId, email, roles, optStr(f.party_id, 40), sha256(token), ctx.userId]);
  await c.query(`INSERT INTO outbox(tenant_id,topic,key,payload) VALUES ($1,'email',$2,$3) ON CONFLICT (key) DO NOTHING`,
    [ctx.tenantId, `invite:${sha256(token)}`, JSON.stringify({ template: "invitation", email })]);
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
  return db.system(async (c) => {
    let user = (await c.query<any>(`SELECT id FROM users WHERE email=$1`, [inv.email])).rows[0];
    if (!user) {
      checkPasswordStrength(f.password);
      if (!String(f.name ?? "").trim()) throw badRequest("Enter your name.");
      user = (await c.query<any>(`INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id`, [inv.email, f.name.trim(), await hashPassword(f.password)])).rows[0];
    }
    await c.query(
      `INSERT INTO memberships(tenant_id,user_id,roles,party_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id,user_id) DO UPDATE SET roles=EXCLUDED.roles, active=true, party_id=EXCLUDED.party_id`,
      [inv.tenant_id, user.id, inv.roles, inv.party_id]);
    await c.query(`UPDATE invitations SET accepted_at=now() WHERE id=$1 AND accepted_at IS NULL`, [inv.id]);
    await audit(c, inv.tenant_id, { kind: "user", userId: user.id }, "team.joined", "user", user.id);
    return { userId: user.id, tenantId: inv.tenant_id };
  });
}

export async function setRoles(c: Conn, ctx: Ctx, userId: string, roles: unknown) {
  require(ctx, "team.manage");
  const rs = cleanRoles(roles);
  const owners = (await c.query<any>(`SELECT user_id FROM memberships WHERE active AND 'owner' = ANY(roles)`)).rows;
  if (owners.length === 1 && owners[0].user_id === userId && !rs.includes("owner")) throw badRequest("A workspace must keep at least one owner.");
  await c.query(`UPDATE memberships SET roles=$2 WHERE user_id=$1`, [userId, rs]);
  await audit(c, ctx.tenantId, actorOf(ctx), "team.roles_changed", "user", userId, { roles: rs });
}

export async function deactivate(c: Conn, ctx: Ctx, userId: string) {
  require(ctx, "team.manage");
  const owners = (await c.query<any>(`SELECT user_id FROM memberships WHERE active AND 'owner' = ANY(roles)`)).rows;
  if (owners.length === 1 && owners[0].user_id === userId) throw badRequest("A workspace must keep at least one owner.");
  await c.query(`UPDATE memberships SET active=false WHERE user_id=$1`, [userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "team.deactivated", "user", userId);
}
