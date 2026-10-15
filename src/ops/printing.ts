import type { Conn, Db } from "../db/client.js";
import { rateLimit } from "../adapters/rate-limit.js";
import { audit } from "../lib/audit.js";
import { actorOf, require, type Ctx } from "../lib/perms.js";
import { badRequest, randomToken, sha256 } from "../lib/util.js";
import { assertWritable } from "../platform/entitlements.js";
import { must, recordId, reqStr } from "./common.js";
import { zpl, type LabelSpec } from "./wh-labels.js";

/**
 * Label printing through a site agent. The agent (scripts/print-agent.mjs) runs on the warehouse network with a token, asks for queued jobs, writes each to its
 * printer's raw TCP port and reports the result. A job is leased for two minutes when handed out; a lease that lapses without a result puts the job back, up to
 * three attempts, then it is marked failed for a person. Payloads are ZPL for labels built from codes and descriptions, never personal data.
 */
const LEASE_SECONDS = 120, MAX_ATTEMPTS = 3, MAX_PAYLOAD = 200_000;

export async function createPrintAgent(c: Conn, ctx: Ctx, label: string) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  const token = `lbtp_${randomToken(32)}`;
  const id = (await c.query<any>(`INSERT INTO print_agents(tenant_id,label,token_hash,created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.tenantId, reqStr(label, "Agent name", 80), sha256(token), ctx.userId]).catch((e) => {
    if (/unique/i.test(String(e.message))) throw badRequest("An agent with that name already exists."); throw e;
  })).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "print_agent.created", "print_agent", id);
  return { id: id as string, token };                                   // shown once
}
export async function retirePrintAgent(c: Conn, ctx: Ctx, id: string) {
  require(ctx, "settings.manage");
  await must(c.query(`UPDATE print_agents SET status='retired' WHERE id=$1 RETURNING id`, [recordId(id, "Agent")]), "Agent");
  await audit(c, ctx.tenantId, actorOf(ctx), "print_agent.retired", "print_agent", id);
}
export async function addPrinter(c: Conn, ctx: Ctx, f: Record<string, any>) {
  require(ctx, "settings.manage");
  await assertWritable(c, ctx.tenantId);
  await must(c.query(`SELECT id FROM print_agents WHERE id=$1 AND status='active'`, [recordId(f.agent_id, "Agent")]), "Agent");
  const host = reqStr(f.host, "Printer address", 120), port = Number(f.port || 9100);
  if (!/^[A-Za-z0-9.-]{1,120}$/.test(host)) throw badRequest("The printer address is a host name or IP address.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("The printer port is 1–65535 (raw printing is usually 9100).");
  const id = (await c.query<any>(`INSERT INTO print_printers(tenant_id,agent_id,name,host,port) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.tenantId, f.agent_id, reqStr(f.name, "Printer name", 80), host, port]).catch((e) => {
    if (/unique/i.test(String(e.message))) throw badRequest("A printer with that name already exists."); throw e;
  })).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "printer.added", "printer", id, { host, port });
  return id as string;
}
export async function queueLabels(c: Conn, ctx: Ctx, printerId: string, labels: LabelSpec[], copies = 1) {
  require(ctx, "wh.write");
  await assertWritable(c, ctx.tenantId);
  if (!labels.length || labels.length > 300) throw badRequest("Print between 1 and 300 labels at a time.");
  const p = await must(c.query<any>(`SELECT p.id FROM print_printers p JOIN print_agents a ON a.id=p.agent_id WHERE p.id=$1 AND p.active AND a.status='active'`, [recordId(printerId, "Printer")]), "Active printer");
  const payload = labels.map((l) => zpl(l, copies)).join("\n");
  if (payload.length > MAX_PAYLOAD) throw badRequest("That is too much for one print job. Print fewer labels.");
  const id = (await c.query<any>(`INSERT INTO print_jobs(tenant_id,printer_id,kind,payload,created_by) VALUES ($1,$2,'labels',$3,$4) RETURNING id`, [ctx.tenantId, p.id, payload, ctx.userId])).rows[0].id;
  await audit(c, ctx.tenantId, actorOf(ctx), "print_job.queued", "print_job", id, { labels: labels.length, copies });
  return id as string;
}
export const listPrintAgents = (c: Conn) => c.query<any>(`SELECT * FROM print_agents ORDER BY created_at DESC`).then((r) => r.rows);
export const listPrinters = (c: Conn) => c.query<any>(`SELECT p.*, a.label AS agent_label, a.last_seen FROM print_printers p JOIN print_agents a ON a.id=p.agent_id ORDER BY p.name`).then((r) => r.rows);
export const listPrintJobs = (c: Conn, limit = 30) => c.query<any>(`SELECT j.id, j.kind, j.status, j.attempts, j.error, j.created_at, j.done_at, p.name AS printer FROM print_jobs j JOIN print_printers p ON p.id=j.printer_id ORDER BY j.created_at DESC LIMIT $1`, [limit]).then((r) => r.rows);

// ───────── agent protocol (bearer token, no session)
async function agentOf(db: Db, auth: string | undefined) {
  const m = /^Bearer (lbtp_[A-Za-z0-9_-]{20,80})$/.exec(auth ?? "");
  if (!m) return null;
  const a = (await db.system((c) => c.query<any>(`SELECT * FROM print_agents WHERE token_hash=$1`, [sha256(m[1])]))).rows[0];
  return a && a.status === "active" ? a : null;
}
/** Hands out up to `max` jobs for this agent's printers and leases them. Lapsed leases are requeued first; a job out of attempts fails. */
export async function pollPrintJobs(db: Db, auth: string | undefined, max = 10): Promise<{ status: number; body: unknown }> {
  const a = await agentOf(db, auth);
  if (!a) return { status: 401, body: { error: "invalid token" } };
  await rateLimit(`print-agent:${a.id}`, 120, 60);
  const jobs = await db.tenant(a.tenant_id, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`${a.tenant_id}:print:${a.id}`]);
    await c.query(`UPDATE print_agents SET last_seen=now() WHERE id=$1`, [a.id]);
    await c.query(`UPDATE print_jobs SET status='failed', error='No result from the print agent after ${MAX_ATTEMPTS} attempts', done_at=now() WHERE status='leased' AND leased_until < now() AND attempts >= ${MAX_ATTEMPTS}`);
    await c.query(`UPDATE print_jobs SET status='queued' WHERE status='leased' AND leased_until < now()`);
    const rows = (await c.query<any>(
      `SELECT j.id, j.payload, p.host, p.port FROM print_jobs j JOIN print_printers p ON p.id=j.printer_id WHERE p.agent_id=$1 AND p.active AND j.status='queued' ORDER BY j.created_at LIMIT $2 FOR UPDATE OF j SKIP LOCKED`, [a.id, Math.min(20, Math.max(1, max))])).rows;
    for (const r of rows) await c.query(`UPDATE print_jobs SET status='leased', attempts=attempts+1, leased_until=now() + ($2 || ' seconds')::interval WHERE id=$1`, [r.id, String(LEASE_SECONDS)]);
    return rows;
  });
  return { status: 200, body: { jobs } };
}
export async function reportPrintResult(db: Db, auth: string | undefined, body: { id?: string; ok?: boolean; error?: string }): Promise<{ status: number; body: unknown }> {
  const a = await agentOf(db, auth);
  if (!a) return { status: 401, body: { error: "invalid token" } };
  if (!body?.id || typeof body.ok !== "boolean") return { status: 400, body: { error: "send {id, ok, error?}" } };
  const r = await db.tenant(a.tenant_id, async (c) => {
    const j = (await c.query<any>(`SELECT j.id, j.status, j.attempts FROM print_jobs j JOIN print_printers p ON p.id=j.printer_id WHERE j.id=$1 AND p.agent_id=$2 FOR UPDATE OF j`, [body.id, a.id])).rows[0];
    if (!j) return "missing";
    if (j.status !== "leased") return "settled";
    if (body.ok) await c.query(`UPDATE print_jobs SET status='done', done_at=now(), error=NULL WHERE id=$1`, [j.id]);
    else if (j.attempts >= MAX_ATTEMPTS) await c.query(`UPDATE print_jobs SET status='failed', done_at=now(), error=$2 WHERE id=$1`, [j.id, String(body.error ?? "printer error").slice(0, 200)]);
    else await c.query(`UPDATE print_jobs SET status='queued', leased_until=NULL, error=$2 WHERE id=$1`, [j.id, String(body.error ?? "printer error").slice(0, 200)]);
    return "ok";
  });
  return r === "missing" ? { status: 404, body: { error: "unknown job" } } : { status: 200, body: { ok: true, settled: r === "settled" } };
}
