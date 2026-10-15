import net from "node:net";
import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { freshDb, newTenant } from "./helpers.js";
import { addPrinter, createPrintAgent, listPrintJobs, queueLabels, retirePrintAgent } from "../src/ops/printing.js";
import { resetThrottle } from "../src/platform/auth.js";
// @ts-expect-error plain ESM script
import { sendToPrinter, tick } from "../scripts/print-agent.mjs";

let db: Db, app: ReturnType<typeof buildApp>;
beforeAll(async () => { db = await freshDb(); app = buildApp(db); });
const api = (path: string, token: string | null, body: unknown = {}) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });

async function site() {
  const t = await newTenant(db, undefined, ["contract-warehouse-3pl"]);
  const run = <T,>(fn: (c: any) => Promise<T>) => db.tenant(t.tenantId, fn);
  const agent = await run((c) => createPrintAgent(c, t.ctx, "Dock PC"));
  const printer = await run((c) => addPrinter(c, t.ctx, { agent_id: agent.id, name: "Dock Zebra", host: "192.168.1.50", port: 9100 }));
  return { t, run, agent, printer };
}

describe("label printing through a site agent", () => {
  it("queues ZPL, leases it once to the agent, and records the result; failures retry then fail for a person", async () => {
    resetThrottle();
    const s = await site();
    expect((await api("/api/print/poll", null)).status).toBe(401);
    expect((await api("/api/print/poll", "lbtp_" + "x".repeat(32))).status).toBe(401);
    await s.run((c) => queueLabels(c, s.t.ctx, s.printer, [{ code: "A-01-01", title: "A-01-01" }, { code: "A-01-02", title: "A-01-02" }], 2));
    const first: any = await (await api("/api/print/poll", s.agent.token)).json();
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]).toMatchObject({ host: "192.168.1.50", port: 9100 });
    expect(first.jobs[0].payload).toContain("^PQ2"); expect(first.jobs[0].payload).toContain("A-01-02");
    expect(((await (await api("/api/print/poll", s.agent.token)).json()) as any).jobs).toHaveLength(0);         // leased, not handed out twice
    expect(await (await api("/api/print/result", s.agent.token, { id: first.jobs[0].id, ok: true })).json()).toMatchObject({ ok: true });
    expect((await s.run((c) => listPrintJobs(c)))[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(await (await api("/api/print/result", s.agent.token, { id: first.jobs[0].id, ok: false })).json()).toMatchObject({ settled: true });

    await s.run((c) => queueLabels(c, s.t.ctx, s.printer, [{ code: "B-1", title: "B-1" }]));
    for (let i = 1; i <= 3; i++) {
      const j: any = await (await api("/api/print/poll", s.agent.token)).json();
      expect(j.jobs).toHaveLength(1);
      await api("/api/print/result", s.agent.token, { id: j.jobs[0].id, ok: false, error: "printer refused the connection" });
    }
    expect((await s.run((c) => listPrintJobs(c)))[0]).toMatchObject({ status: "failed", attempts: 3, error: "printer refused the connection" });
    expect(((await (await api("/api/print/poll", s.agent.token)).json()) as any).jobs).toHaveLength(0);

    // a lease that lapses puts the job back
    await s.run((c) => queueLabels(c, s.t.ctx, s.printer, [{ code: "C-1", title: "C-1" }]));
    const lost: any = await (await api("/api/print/poll", s.agent.token)).json();
    await db.system((c) => c.query(`UPDATE print_jobs SET leased_until=now() - interval '1 second' WHERE id=$1`, [lost.jobs[0].id]));
    expect(((await (await api("/api/print/poll", s.agent.token)).json()) as any).jobs).toHaveLength(1);
  });

  it("keeps agents apart, refuses a retired agent, and validates set-up", async () => {
    resetThrottle();
    const a = await site(), b = await site();
    await a.run((c) => queueLabels(c, a.t.ctx, a.printer, [{ code: "A-1", title: "A-1" }]));
    expect(((await (await api("/api/print/poll", b.agent.token)).json()) as any).jobs).toHaveLength(0);       // another workspace's agent sees nothing
    const j: any = await (await api("/api/print/poll", a.agent.token)).json();
    expect((await api("/api/print/result", b.agent.token, { id: j.jobs[0].id, ok: true })).status).toBe(404);
    await a.run((c) => retirePrintAgent(c, a.t.ctx, a.agent.id));
    expect((await api("/api/print/poll", a.agent.token)).status).toBe(401);
    await expect(a.run((c) => queueLabels(c, a.t.ctx, a.printer, [{ code: "A-2", title: "A-2" }]))).rejects.toThrow(/Active printer/);
    const c2 = await site();
    await expect(c2.run((c) => addPrinter(c, c2.t.ctx, { agent_id: c2.agent.id, name: "Bad", host: "bad host!", port: 9100 }))).rejects.toThrow(/host name or IP/);
    await expect(c2.run((c) => addPrinter(c, c2.t.ctx, { agent_id: c2.agent.id, name: "Bad2", host: "10.0.0.1", port: 70000 }))).rejects.toThrow(/1–65535/);
    await expect(c2.run((c) => queueLabels(c, c2.t.ctx, c2.printer, []))).rejects.toThrow(/between 1 and 300/);
    await expect(c2.run((c) => createPrintAgent(c, c2.t.ctx, "Dock PC"))).rejects.toThrow(/already exists/);
  });

  it("the agent script writes the payload to a real TCP socket and reports back", async () => {
    const got: string[] = [];
    const printer = net.createServer((sock) => { let d = ""; sock.on("data", (x) => (d += x)); sock.on("end", () => got.push(d)); });
    await new Promise<void>((r) => printer.listen(0, "127.0.0.1", r));
    const port = (printer.address() as net.AddressInfo).port;
    await sendToPrinter("127.0.0.1", port, "^XA^FDhello^FS^XZ");
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(["^XA^FDhello^FS^XZ"]);
    await expect(sendToPrinter("127.0.0.1", 1, "x")).rejects.toThrow(/refused/);
    // a full round: poll the app, print to the socket, report done
    resetThrottle();
    const s = await site();
    await s.run((c) => addPrinter(c, s.t.ctx, { agent_id: s.agent.id, name: "Local", host: "127.0.0.1", port }));
    const local = (await db.query<any>(`SELECT id FROM print_printers WHERE tenant_id=$1 AND name='Local'`, [s.t.tenantId])).rows[0].id;
    await s.run((c) => queueLabels(c, s.t.ctx, local, [{ code: "Z-9", title: "Z-9" }]));
    const viaApp = ((path: string, init: RequestInit) => app.request(new URL(path).pathname, init)) as any;
    got.length = 0;
    await tick({ server: "http://app.test", token: s.agent.token, fetchImpl: viaApp });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1); expect(got[0]).toContain("Z-9");
    expect((await s.run((c) => listPrintJobs(c)))[0].status).toBe("done");
    await expect(tick({ server: "http://app.test", token: "lbtp_" + "y".repeat(32), fetchImpl: viaApp })).rejects.toThrow(/refused this token/);
    printer.close();
  });
});
