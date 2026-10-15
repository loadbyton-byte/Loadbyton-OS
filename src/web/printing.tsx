import { Hono } from "hono";
import { formatDate } from "../lib/util.js";
import { addPrinter, createPrintAgent, listPrintAgents, listPrintJobs, listPrinters, pollPrintJobs, queueLabels, reportPrintResult, retirePrintAgent } from "../ops/printing.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

/** The site agent's protocol: bearer token, no session. */
export const printApi = new Hono<Env>();
printApi.post("/api/print/poll", async (c) => { const r = await pollPrintJobs(c.get("db"), c.req.header("authorization")); return c.json(r.body as any, r.status as any); });
printApi.post("/api/print/result", async (c) => { const body = await c.req.json().catch(() => ({})); const r = await reportPrintResult(c.get("db"), c.req.header("authorization"), body); return c.json(r.body as any, r.status as any); });

export const printUi = new Hono<Env>();
const U = "/app/warehouse/printing";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;

printUi.get(U, async (c) => {
  need(c, "wh.write");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ agents: await listPrintAgents(cn), printers: await listPrinters(cn), jobs: await listPrintJobs(cn),
    locations: (await cn.query<any>(`SELECT code FROM wh_locations WHERE active ORDER BY code LIMIT 300`).catch(() => ({ rows: [] }))).rows }));
  const mgr = can(c, "settings.manage");
  return appPage(c, "Label printing", <>
    <PageHead title="Label printing" sub="A small agent on your warehouse network collects print jobs from here and sends them to your thermal printers. The server never connects into your network." />
    <Table head={["Agent", "Last seen", "State", ""]} empty="No print agent yet.">
      {d.agents.map((a: any) => <tr><td>{a.label}</td><td class="small">{a.last_seen ? formatDate(a.last_seen) : "never"}</td><td>{a.status === "active" ? <Badge s="ok" label="active" /> : <Badge s="closed" label="retired" />}</td>
        <td>{mgr && a.status === "active" ? <form method="post" action={`${U}/agents/${a.id}/retire`}><Csrf t={csrf} /><button class="btn ghost sm">Retire</button></form> : null}</td></tr>)}</Table>
    <Table head={["Printer", "Address", "Agent"]} empty="No printers yet.">{d.printers.map((p: any) => <tr><td>{p.name}</td><td>{p.host}:{p.port}</td><td>{p.agent_label}</td></tr>)}</Table>
    {d.printers.length ? <form class="card" method="post" action={`${U}/print`}><Csrf t={csrf} /><h2>Print location labels</h2>
      <div class="field"><label for="printer_id">Printer</label><select id="printer_id" name="printer_id">{d.printers.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
      <div class="field"><label for="codes">Codes, one per line</label><textarea id="codes" name="codes" rows={5} required placeholder={d.locations.slice(0, 3).map((l: any) => l.code).join("\n")}></textarea></div>
      {field("copies", "Copies of each", { type: "number", value: "1", min: "1", max: "50" })}<button class="btn">Send to printer</button></form> : null}
    <section class="card"><h2>Recent jobs</h2><Table head={["Time", "Printer", "Status", "Attempts", "Detail"]} empty="Nothing printed yet.">
      {d.jobs.map((j: any) => <tr><td class="small">{formatDate(j.created_at)}</td><td>{j.printer}</td><td><Badge s={j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "info"} label={j.status} /></td><td>{j.attempts}</td><td class="small">{j.error ?? ""}</td></tr>)}</Table></section>
    {mgr ? <>
      <form class="card" method="post" action={`${U}/agents`}><Csrf t={csrf} /><h2>Add a print agent</h2>{field("label", "Name (for example Dock office PC)", { required: true })}<button class="btn">Create agent</button></form>
      {d.agents.length ? <form class="card" method="post" action={`${U}/printers`}><Csrf t={csrf} /><h2>Add a printer</h2>
        <div class="field"><label for="agent_id">Agent that can reach it</label><select id="agent_id" name="agent_id">{d.agents.filter((a: any) => a.status === "active").map((a: any) => <option value={a.id}>{a.label}</option>)}</select></div>
        {field("name", "Printer name", { required: true })}{field("host", "Address on your network (IP or host name)", { required: true })}{field("port", "Raw port", { type: "number", value: "9100" })}<button class="btn">Add printer</button></form> : null}</> : null}
  </>);
});
printUi.post(`${U}/agents`, async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  try {
    const r = await withT(c, (cn, ctx) => createPrintAgent(cn, ctx, str(b.label)));
    return appPage(c, "Print agent created", <><PageHead title="Print agent created" sub="Copy the token now. It is not shown again." />
      <section class="card"><p><strong>Token</strong><br /><code>{r.token}</code></p><p class="small">On the warehouse PC: <code>PRINT_SERVER=https://your-host PRINT_TOKEN=… node scripts/print-agent.mjs</code></p></section><p><a class="btn" href={U}>Back to printing</a></p></>);
  } catch (e: any) { if (e?.status && e.status < 500) { const { back } = await import("./appkit.js"); return back(c, U, undefined, e.message); } throw e; }
});
printUi.post(`${U}/agents/:id/retire`, async (c) => { const id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => retirePrintAgent(cn, ctx, id)); return { to: U, ok: "Agent retired." }; }); });
printUi.post(`${U}/printers`, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => addPrinter(cn, ctx, b)); return { to: U, ok: "Printer added." }; }); });
printUi.post(`${U}/print`, async (c) => {
  const b = await formBody(c);
  const codes = str(b.codes).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return act(c, U, async () => { await withT(c, (cn, ctx) => queueLabels(cn, ctx, str(b.printer_id), codes.map((code) => ({ code, title: code })), Number(str(b.copies) || 1))); return { to: U, ok: `${codes.length} label(s) queued. The agent sends them within a few seconds.` }; });
});
