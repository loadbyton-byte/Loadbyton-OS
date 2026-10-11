import { Hono } from "hono";
import { formatDate } from "../lib/util.js";
import { bindDevice, caseMonitor, deviceOverview, handleDeviceFeed, importLoggerCsv, registerDevice, retireDevice, unbindDevice } from "../ops/device-feed.js";
import { act, appPage, can, need, PageHead, withT, ctxOf } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

/** Signed logger pushes: public, tenant-less, no session. */
export const deviceHooks = new Hono<Env>();
deviceHooks.all("/webhooks/devices/:token", async (c) => {
  const raw = c.req.method === "POST" ? await c.req.text() : "";
  const r = await handleDeviceFeed(c.get("db"), c.req.param("token"), { method: c.req.method, raw, header: (n) => c.req.header(n) });
  return c.json(r.body as any, r.status as any);
});

export const deviceUi = new Hono<Env>();
const U = "/app/cold-chain";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;

/** Temperature trace as an inline SVG: the permitted band, each reading, excursions in red. */
function Chart({ m }: { m: Awaited<ReturnType<typeof caseMonitor>> }) {
  const pts = m.points;
  if (pts.length < 2) return <p class="mute">At least two readings are needed to draw a trace.</p>;
  const W = 760, H = 240, L = 44, R = 12, T = 12, B = 28;
  const t0 = pts[0].at.getTime(), t1 = pts[pts.length - 1].at.getTime() || t0 + 1;
  const ys = [...pts.map((p) => p.celsius), m.range.lo, m.range.hi], lo = Math.floor(Math.min(...ys) - 1), hi = Math.ceil(Math.max(...ys) + 1);
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R), y = (v: number) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.at.getTime()).toFixed(1)},${y(p.celsius).toFixed(1)}`).join(" ");
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Temperature trace between ${m.range.lo} and ${m.range.hi} degrees Celsius`} style="width:100%;max-width:760px;height:auto" data-notranslate>
    <rect x={L} y={y(m.range.hi)} width={W - L - R} height={Math.max(1, y(m.range.lo) - y(m.range.hi))} fill="#E3F2EA" />
    <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="#8EA3BA" /><line x1={L} y1={T} x2={L} y2={H - B} stroke="#8EA3BA" />
    <text x={4} y={y(m.range.hi) + 4} font-size="11">{m.range.hi}°</text><text x={4} y={y(m.range.lo) + 4} font-size="11">{m.range.lo}°</text>
    <text x={L} y={H - 8} font-size="11">{pts[0].at.toISOString().slice(5, 16).replace("T", " ")}</text><text x={W - R - 90} y={H - 8} font-size="11">{pts[pts.length - 1].at.toISOString().slice(5, 16).replace("T", " ")}</text>
    <path d={path} fill="none" stroke="#071D35" stroke-width="1.5" />
    {pts.map((p) => <circle cx={x(p.at.getTime())} cy={y(p.celsius)} r={p.out ? 3.5 : 1.8} fill={p.out ? "#C8102E" : "#071D35"} />)}
  </svg>;
}

deviceUi.get(`${U}/devices`, async (c) => {
  need(c, "specialist.write");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({ devices: await deviceOverview(cn), cases: (await cn.query<any>(`SELECT id,no,subject_ref,status,sector FROM specialist_cases WHERE sector IN ('cold-chain','automotive-logistics') AND status IN ('ready','active','hold') ORDER BY created_at DESC LIMIT 100`)).rows }));
  return appPage(c, "Temperature loggers", <>
    <PageHead title="Temperature loggers" sub="Register a logger, bind it to a cold-chain case, and its signed pushes or downloaded CSV become temperature readings. Every reading is kept, with why it was or was not accepted." />
    <Table head={["Logger", "Serial", "Case", "Last reading", "Accepted", "Rejected", "State", ""]} empty={d.devices.length ? undefined : "No loggers registered."}>
      {d.devices.map((x: any) => <tr><td>{x.label}<div class="small mute">every {x.interval_minutes} min</div></td><td>{x.serial}</td>
        <td>{x.case_no ? <a href={`${U}/cases/${x.case_id}`}>{x.case_no}</a> : "—"}{x.bound ? "" : x.case_no ? " (unbound)" : ""}</td><td class="small">{x.last_seen ? formatDate(x.last_seen) : "none yet"}</td><td>{x.ingested}</td><td>{x.rejected}</td>
        <td>{x.status === "retired" ? <Badge s="closed" label="retired" /> : x.silent ? <Badge s="bad" label="silent" /> : x.bound ? <Badge s="ok" label="reporting" /> : <Badge s="info" label="idle" />}</td>
        <td>{x.status === "active" && can(c, "specialist.write") ? (x.bound
          ? <form method="post" action={`${U}/devices/${x.id}/unbind`}><Csrf t={csrf} /><button class="btn ghost sm">Unbind</button></form>
          : <form method="post" action={`${U}/devices/${x.id}/bind`} class="inline-form"><Csrf t={csrf} /><select name="case_id">{d.cases.map((k: any) => <option value={k.id}>{k.no} · {k.subject_ref}{k.sector === "automotive-logistics" ? " (yard)" : ""}</option>)}</select><input name="since" type="datetime-local" title="Monitoring started (optional)" aria-label="Monitoring started (optional)" /><button class="btn sm">Bind</button></form>) : null}</td></tr>)}</Table>
    {can(c, "specialist.write") ? <>
      <form class="card" method="post" action={`${U}/devices`}><Csrf t={csrf} /><h2>Register a device</h2>
        <div class="field"><label for="sector">Kind</label><select id="sector" name="sector"><option value="cold-chain">Temperature logger (cold chain)</option><option value="automotive-logistics">Yard scanner / telematics (automotive logistics)</option></select></div>
        {field("label", "Label", { required: true })}{field("serial", "Serial number", { required: true })}{field("interval_minutes", "Logging interval (minutes)", { type: "number", value: "15", min: "1", max: "1440" })}<button class="btn">Register</button></form>
      <form class="card" method="post" action={`${U}/devices/import`}><Csrf t={csrf} /><h2>Import a logger download (CSV)</h2>
        <div class="field"><label for="device_id">Logger</label><select id="device_id" name="device_id">{d.devices.filter((x: any) => x.status === "active").map((x: any) => <option value={x.id}>{x.label} · {x.serial}</option>)}</select></div>
        <div class="field"><label for="csv">CSV with a UTC ISO-8601 time column and a temperature column in °C</label><textarea id="csv" name="csv" rows={6} required placeholder={"time,celsius\n2026-10-11T04:00:00Z,4.2"}></textarea></div><button class="btn">Import readings</button></form></> : null}
    <section class="card"><h2>Push format</h2><p class="small">POST JSON <code>{'{"readings":[{"id":"1","at":"2026-10-11T04:00:00Z","celsius":4.2}]}'}</code> (1–500 readings) to the device's secret URL. Yard scanners send <code>{'{"readings":[{"id":"1","at":"2026-10-11T04:00:00Z","location":"Bay C4"}]}'}</code> instead, and each accepted scan becomes a yard-movement event on the bound automotive case. Sign every push with <code>X-LBT-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")</code>. The URL and secret are shown once when you register the device. Readings repeat safely.</p></section>
  </>);
});
deviceUi.post(`${U}/devices`, async (c) => {
  need(c, "specialist.write");
  const b = await formBody(c);
  try {
    const r = await withT(c, (cn, ctx) => registerDevice(cn, ctx, { label: str(b.label), serial: str(b.serial), interval_minutes: str(b.interval_minutes), sector: str(b.sector) || undefined }));
    return appPage(c, "Logger registered", <><PageHead title="Logger registered" sub="Copy these now. They are not shown again." />
      <section class="card"><p><strong>Push URL</strong><br /><code>{r.url}</code></p><p><strong>Signing secret</strong><br /><code>{r.secret}</code></p></section><p><a class="btn" href={`${U}/devices`}>Back to loggers</a></p></>);
  } catch (e: any) { if (e?.status && e.status < 500) { const { back } = await import("./appkit.js"); return back(c, `${U}/devices`, undefined, e.message); } throw e; }
});
deviceUi.post(`${U}/devices/import`, async (c) => {
  const b = await formBody(c);
  return act(c, `${U}/devices`, async () => { const r = await importLoggerCsv(c.get("db"), ctxOf(c), str(b.device_id), str(b.csv)); return { to: `${U}/devices`, ok: `${r.rows} rows: ${r.ingested} accepted, ${r.rejected} rejected, ${r.duplicates} already held.${r.rejections[0] ? ` First rejection: ${r.rejections[0].reason}` : ""}` }; });
});
const dp = (path: string, run: (cn: any, ctx: any, id: string, b: Record<string, any>) => Promise<unknown>, ok: string) =>
  deviceUi.post(`${U}/devices/:id/${path}`, async (c) => { const id = c.req.param("id"), b = await formBody(c); return act(c, `${U}/devices`, async () => { await withT(c, (cn, ctx) => run(cn, ctx, id, b)); return { to: `${U}/devices`, ok }; }); });
dp("bind", (cn, ctx, id, b) => bindDevice(cn, ctx, id, str(b.case_id), str(b.since) ? new Date(str(b.since)).toISOString() : undefined), "Logger bound to the case.");
dp("unbind", (cn, ctx, id) => unbindDevice(cn, ctx, id), "Logger unbound.");
dp("retire", (cn, ctx, id) => retireDevice(cn, ctx, id), "Logger retired.");

deviceUi.get(`${U}/cases/:id`, async (c) => {
  need(c, "read");
  const m = await withT(c, (cn) => caseMonitor(cn, c.req.param("id")));
  const s = m.stats;
  return appPage(c, `${m.case.no} temperature`, <>
    <PageHead title={`${m.case.no} · temperature monitoring`} sub={`Permitted range ${m.range.lo}–${m.range.hi} °C`}><Badge s={m.case.status} /><a class="btn ghost sm" href={`/app/specialists/cold-chain/${m.case.id}`}>Open case</a></PageHead>
    {s ? <div class="grid g4"><div class="card"><h3>Readings</h3><div class="kpi">{s.n}</div></div><div class="card"><h3>Min / max</h3><div class="kpi">{s.min} / {s.max} °C</div></div>
      <div class="card"><h3>Mean kinetic temp.</h3><div class="kpi">{s.mkt} °C</div><p class="small mute">Pharmacopoeial convention (ΔH/R 10,000 K)</p></div>
      <div class="card"><h3>Out of range</h3><div class={`kpi ${s.excursions ? "bad" : "good"}`}>{s.excursions}</div><p class="small mute">≈ {s.minutes_out_of_range} min (estimate)</p></div></div> : <p>No readings yet.</p>}
    <Chart m={m} />
    {m.gaps.length ? <section class="card"><h2>Gaps in the record</h2><ul>{m.gaps.map((g) => <li>{formatDate(g.from)} → {formatDate(g.to)} · {g.minutes} minutes without a reading</li>)}</ul></section> : null}
    {m.rejected.length ? <section class="card"><h2>Readings that were not accepted</h2><Table head={["Observed", "°C", "Logger", "Why"]}>{m.rejected.map((r: any) => <tr><td class="small">{formatDate(r.observed_at)}</td><td>{r.celsius}</td><td>{r.serial}</td><td class="small">{r.reason}</td></tr>)}</Table></section> : null}
    <p class="small mute">The estimate of time out of range counts the interval after each out-of-range reading, capped at twice the logging interval. It supports a person's judgement; it is not a stability decision.</p>
  </>);
});
