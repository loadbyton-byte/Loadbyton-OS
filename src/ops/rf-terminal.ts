import type { Conn, Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { actorOf, permsFor, require, type Ctx } from "../lib/perms.js";
import { HttpError, badRequest, hashPassword, verifyPassword } from "../lib/util.js";
import { recordId } from "./common.js";
import { resolveScan, rfMove } from "./wh-labels.js";

/**
 * Text terminal for handheld RF guns that speak a plain line protocol (Telnet-style, 20-column or wider screens). It is the only way to reach old fixed-format guns; it carries every
 * keystroke in the clear, so run it only on a private network or inside a VPN. Sign-in is company + e-mail + numeric PIN set by a manager; five wrong PINs lock that user for 15 minutes.
 */
export const MAX_PIN_FAILS = 5, LOCK_MINUTES = 15;

export async function setRfPin(c: Conn, ctx: Ctx, userId: string, pin: string) {
  require(ctx, "settings.manage");
  if (!/^\d{6,10}$/.test(pin)) throw badRequest("The PIN is 6 to 10 digits.");
  if (/^(\d)\1+$/.test(pin) || "01234567890123456789".includes(pin) || "98765432109876543210".includes(pin)) throw badRequest("Choose a PIN that is not a repeated or sequential number.");
  const uid = recordId(userId, "User");
  if (!(await c.query(`SELECT 1 FROM memberships WHERE user_id=$1 AND active`, [uid])).rows.length) throw badRequest("That person is not an active member of this company.");
  await c.query(`INSERT INTO rf_pins(tenant_id,user_id,pin_hash,set_by) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,user_id) DO UPDATE SET pin_hash=EXCLUDED.pin_hash, failed=0, locked_until=NULL, set_by=EXCLUDED.set_by, set_at=now()`, [ctx.tenantId, uid, await hashPassword(pin), ctx.userId]);
  await audit(c, ctx.tenantId, actorOf(ctx), "rf_pin.set", "user", uid);
}

let dummy: string | undefined;
/** Returns a Ctx on success, otherwise a short reason. The failure counter is written in its own committed transaction. */
export async function rfLogin(db: Db, slug: string, email: string, pin: string): Promise<{ ok: true; ctx: Ctx } | { ok: false; reason: string }> {
  dummy ??= await hashPassword("dummy-pin-for-timing");
  const bad = { ok: false as const, reason: "Sign-in failed." };
  const row = (await db.system((c) => c.query<any>(
    `SELECT t.id AS tenant_id, u.id AS user_id, m.roles, p.pin_hash, p.failed, p.locked_until, (p.locked_until IS NOT NULL AND p.locked_until > now()) AS locked
       FROM tenants t JOIN memberships m ON m.tenant_id=t.id AND m.active JOIN users u ON u.id=m.user_id LEFT JOIN rf_pins p ON p.tenant_id=t.id AND p.user_id=u.id
      WHERE t.slug=$1 AND t.status='active' AND lower(u.email)=lower($2)`, [slug.trim().toLowerCase(), email.trim()]))).rows[0];
  const good = await verifyPassword(pin, row?.pin_hash ?? dummy);
  if (!row?.pin_hash) return bad;
  if (row.locked) return { ok: false, reason: "Locked. Ask a manager or wait 15 minutes." };
  if (!good) {
    await db.system((c) => c.query(`UPDATE rf_pins SET failed=failed+1, locked_until=CASE WHEN failed+1>=$3 THEN now()+make_interval(mins=>$4) ELSE locked_until END WHERE tenant_id=$1 AND user_id=$2`, [row.tenant_id, row.user_id, MAX_PIN_FAILS, LOCK_MINUTES]));
    return bad;
  }
  await db.system((c) => c.query(`UPDATE rf_pins SET failed=0, locked_until=NULL WHERE tenant_id=$1 AND user_id=$2`, [row.tenant_id, row.user_id]));
  const perms = permsFor(row.roles);
  if (!perms.has("wh.write") && !perms.has("read")) return bad;
  return { ok: true, ctx: { userId: row.user_id, tenantId: row.tenant_id, roles: row.roles, perms, partyId: null, driverId: null, readOnly: false, supportStaffId: null } };
}

type Stage = "slug" | "email" | "pin" | "menu" | "look" | "from" | "item" | "qty" | "to" | "confirm";
/** One handheld's conversation. `feed(line)` returns the lines to show next; `closed` tells the server to hang up. */
export class RfSession {
  stage: Stage = "slug"; closed = false; ctx: Ctx | null = null; private slug = ""; private email = ""; private move: Record<string, any> = {};
  constructor(private db: Db, private width = 24) {}
  private wrap(s: string): string[] { const out: string[] = []; for (const part of s.split("\n")) for (let i = 0; i < Math.max(1, part.length); i += this.width) out.push(part.slice(i, i + this.width)); return out; }
  banner() { return this.wrap("LOAD|BY|TON RF\nCompany code:"); }
  private menu() { this.stage = "menu"; return this.wrap("1 Look up\n2 Move stock\n0 Sign out"); }
  async feed(raw: string): Promise<string[]> {
    const line = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (line.toUpperCase() === "QUIT" && this.stage !== "pin") { this.closed = true; return ["Bye."]; }
    switch (this.stage) {
      case "slug": this.slug = line; this.stage = "email"; return this.wrap("User e-mail:");
      case "email": this.email = line; this.stage = "pin"; return this.wrap("PIN:");
      case "pin": {
        const r = await rfLogin(this.db, this.slug, this.email, line);
        if (!r.ok) { this.closed = true; return this.wrap(r.reason); }
        this.ctx = r.ctx; return [...this.wrap("Signed in."), ...this.menu()];
      }
      case "menu":
        if (line === "1") { this.stage = "look"; return this.wrap("Scan or type code:"); }
        if (line === "2") { this.stage = "from"; this.move = {}; return this.wrap("From location:"); }
        if (line === "0") { this.closed = true; return ["Bye."]; }
        return [...this.wrap("Choose 1, 2 or 0."), ...this.menu()];
      case "look": {
        try {
          const hits = await this.db.tenant(this.ctx!.tenantId, (c) => resolveScan(c, this.ctx!, line));
          this.stage = "menu";
          return [...(hits.length ? hits.flatMap((h) => this.wrap(h.kind === "location" ? `LOC ${h.code}` : h.kind === "sku" ? `SKU ${h.code} ${h.owner}` : h.kind === "lot" ? `LOT ${h.lot} ${h.sku}` : `${h.kind.toUpperCase()} ${h.no} ${h.status}`)) : this.wrap("Not found.")), ...this.menu()];
        } catch (e) { this.stage = "menu"; return [...this.wrap(msg(e)), ...this.menu()]; }
      }
      case "from": this.move.from_code = line; this.stage = "item"; return this.wrap("Item or lot:");
      case "item": this.move.item = line; this.stage = "qty"; return this.wrap("Quantity:");
      case "qty": { const q = Number(line); if (!(q > 0)) return this.wrap("Enter a number above 0."); this.move.qty = q; this.stage = "to"; return this.wrap("To location:"); }
      case "to": this.move.to_code = line; this.stage = "confirm"; return this.wrap(`Move ${this.move.qty} ${this.move.item}\n${this.move.from_code} > ${line}\nY to confirm:`);
      case "confirm": {
        if (line.toUpperCase() !== "Y") { this.stage = "menu"; return [...this.wrap("Cancelled."), ...this.menu()]; }
        try {
          const ref = `rf-${this.ctx!.userId.slice(0, 8)}-${Date.now()}`;
          await this.db.tenant(this.ctx!.tenantId, (c) => rfMove(c, this.ctx!, { ...this.move, client_ref: ref }));
          this.stage = "menu"; return [...this.wrap("Moved."), ...this.menu()];
        } catch (e) { this.stage = "menu"; return [...this.wrap(msg(e)), ...this.menu()]; }
      }
    }
  }
}
const msg = (e: unknown) => (e instanceof HttpError ? e.message : "Error. Try again.");
