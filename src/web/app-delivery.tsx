import { Hono } from "hono";
import { HttpError, TAX_CODES, formatDate, formatDay, fmtMoney } from "../lib/util.js";
import {
  createRider, EMIRATES, FAIL_REASONS, CHARGE_LABEL, addToRun, billingSummary, cancelRun, cancelShipment, cashInHand, cashVariances, closeRun, confirmReturned, createRemittance, createRun,
  createShipment, decideSettlement, deliveryOverview, getRemittance, getRun, getShipment, importShipments, invoiceMerchant, listRates, listRemittances, listRuns,
  listSettlements, listShipments, payRemittance, reattemptShipment, remittable, removeFromRun, returnToSender, setRate, settleRider, startRun, trackByToken, voidRemittance,
} from "../ops/delivery.js";
import { invite } from "../ops/team.js";
import { listParties } from "../ops/crm.js";
import { formBody, str, arr, clientIp, type Env } from "./mw.js";
import { rateLimit } from "../lib/ratelimit.js";
import { raw } from "hono/html";
import { barcodeSvg } from "../lib/code128.js";
import { createApiKey, listApiKeys, listMerchantSettings, revokeApiKey, sendTestWebhook, setNotifySms, setNotifyWhatsApp, setWebhook } from "../ops/delivery-notify.js";
import { act, appPage, can, Confirm, need, PageHead, PostBtn, withT } from "./appkit.js";
import { Badge, Csrf, Money, PublicShell, Table } from "./ui.js";
import { config } from "../config.js";

export const delivery = new Hono<Env>();
const D = "/app/delivery";
const dt = (v: any) => (v ? formatDate(v) : "—");

const STATUS_LABEL: Record<string, string> = {
  new: "awaiting dispatch", assigned: "on a run", out_for_delivery: "out for delivery", delivered: "delivered", undelivered: "undelivered — needs a decision",
  return_to_sender: "to be returned", returned: "returned", cancelled: "cancelled",
};
const BADGE: Record<string, string> = { undelivered: "warn", return_to_sender: "warn", out_for_delivery: "info", assigned: "info" };
const St = ({ s }: { s: string }) => <Badge s={BADGE[s] ?? s} label={STATUS_LABEL[s] ?? s} />;
const summarise = (r: { created: number; duplicates: string[]; rejected: { line: number; reason: string }[] }, dry: boolean) =>
  [`${dry ? "Would create" : "Created"} ${r.created}`, r.duplicates.length ? `${r.duplicates.length} already known, skipped` : "",
    r.rejected.length ? `${r.rejected.length} row(s) rejected (${r.rejected.slice(0, 3).map((x) => `line ${x.line}: ${x.reason}`).join("; ")})` : ""].filter(Boolean).join(" · ") + ".";
const ageDays = (v: any) => Math.floor((Date.now() - Date.parse(v)) / 86400000);

// ───────── board
delivery.get(D, async (c) => {
  need(c, "read");
  const d = await withT(c, (cn) => deliveryOverview(cn));
  const cashTotal = d.cash.reduce((a: number, x: any) => a + x.amount_minor, 0);
  const owed = d.remittable.reduce((a: number, x: any) => a + x.gross_minor, 0);
  return appPage(c, "Delivery board", (<>
    <PageHead title="Delivery board" sub="Parcels, riders, and every dirham of cash on delivery — where it is and who owes whom.">
      {can(c, "dlv.write") ? <><a class="btn red sm" href={`${D}/shipments/new`}>New parcel</a><a class="btn sm" href={`${D}/runs/new`}>New run</a></> : null}
    </PageHead>
    <div class="grid g4">
      <div class="card"><h3>Awaiting dispatch</h3><div class="kpi">{d.awaiting}</div></div>
      <div class="card"><h3>Out for delivery</h3><div class="kpi">{d.out}</div></div>
      <div class="card"><h3>Delivered today</h3><div class="kpi good">{d.deliveredToday}</div></div>
      <div class="card"><h3>Late</h3><div class={`kpi ${d.late ? "bad" : "good"}`}>{d.late}</div></div>
    </div>
    <div class="grid g4" style="margin-top:16px">
      <div class="card"><h3>Cash with riders</h3><div class="kpi"><Money v={cashTotal} /></div><p class="small mute">{d.cash.length} rider(s) to count</p></div>
      <div class="card"><h3>Owed to merchants</h3><div class="kpi"><Money v={owed} /></div><p class="small mute">counted in, not yet paid out</p></div>
      <div class="card"><h3>Undelivered</h3><div class={`kpi ${d.undelivered ? "bad" : "good"}`}>{d.undelivered}</div><p class="small mute">{d.toReturn} to return</p></div>
      <div class="card"><h3>Payouts to confirm</h3><div class="kpi">{d.pendingPayouts}</div></div>
    </div>
    {d.conflicts ? <div class="alert warn" style="margin-top:16px"><strong>{d.conflicts} rider event(s)</strong> were stored but not applied in the last 7 days (late sync, parcel recalled, wrong cash). Check the parcels concerned — any cash the rider took will show up as a variance at handover.</div> : null}
    {d.toDecide ? <div class="alert warn" style="margin-top:16px"><strong>{d.toDecide} cash variance(s)</strong> need an independent decision. <a href={`${D}/cash`}>Open cash desk</a></div> : null}
    {d.unrated ? <div class="alert warn" style="margin-top:16px"><strong>{d.unrated} billable line(s) have no rate card.</strong> They are kept and priced when the rate is set. <a href={`${D}/billing`}>Billing</a></div> : null}
    <div class="grid g2" style="margin-top:20px;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr))">
      <section><Table caption="Runs in progress" head={["Run", "Rider", "Done", ["COD", "num"]]} empty={d.activeRuns.length ? undefined : "No active runs."}>
        {d.activeRuns.map((r: any) => <tr><td><a href={`${D}/runs/${r.id}`}>{r.no}</a> <Badge s={r.status === "out" ? "info" : "draft"} label={r.status === "out" ? "out" : "planned"} /></td><td>{r.rider_name}</td><td>{r.delivered}/{r.parcels}</td><td class="num"><Money v={r.collected_minor} /> / <Money v={r.cod_minor} /></td></tr>)}</Table></section>
      <section><Table caption="Needs a decision" head={["Parcel", "Merchant", "Why", "Tries"]} empty={d.needsAction.length ? undefined : "Nothing waiting."}>
        {d.needsAction.map((p: any) => <tr><td><a href={`${D}/shipments/${p.id}`}>{p.no}</a></td><td>{p.merchant}</td><td class="small">{p.last_failure ?? "—"}</td><td>{p.attempts}/{p.max_attempts} <St s={p.status} /></td></tr>)}</Table></section>
      <section><Table caption="Cash with riders" head={["Rider", "Parcels", ["Cash", "num"], "Oldest"]} empty={d.cash.length ? undefined : "All cash is counted in."}>
        {d.cash.map((x: any) => <tr><td>{x.name}</td><td>{x.parcels}</td><td class="num"><Money v={x.amount_minor} /></td><td>{ageDays(x.oldest) >= 1 ? <Badge s="bad" label={`${ageDays(x.oldest)} day(s)`} /> : "today"}</td></tr>)}</Table></section>
      <section><Table caption="Owed to merchants" head={["Merchant", "Parcels", ["COD", "num"], "Oldest"]} empty={d.remittable.length ? undefined : "Nothing waiting to be paid out."}>
        {d.remittable.map((x: any) => <tr><td>{x.name}</td><td>{x.parcels}</td><td class="num"><Money v={x.gross_minor} /></td><td>{ageDays(x.oldest)} day(s)</td></tr>)}</Table></section>
    </div>
  </>));
});

// ───────── parcels
delivery.get(`${D}/shipments`, async (c) => {
  need(c, "read");
  const status = c.req.query("status") ?? "", q = c.req.query("q") ?? "", merchant = c.req.query("merchant") ?? "";
  const d = await withT(c, async (cn) => ({ rows: await listShipments(cn, { status: status || undefined, q, merchantId: merchant || undefined }), merchants: await listParties(cn, "customer") }));
  return appPage(c, "Parcels", (<>
    <PageHead title="Parcels" sub="Latest 300 matching.">
      {can(c, "dlv.write") ? <><a class="btn red sm" href={`${D}/shipments/new`}>New parcel</a><a class="btn sm" href={`${D}/shipments/import`}>Import CSV</a></> : null}
    </PageHead>
    <form method="get" action={`${D}/shipments`} class="inline-form" style="margin-bottom:14px">
      <input name="q" type="search" value={q} placeholder="Waybill, merchant ref, name or phone" />
      <select name="status" aria-label="Status"><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option value={k} selected={k === status}>{v}</option>)}</select>
      <select name="merchant" aria-label="Merchant"><option value="">All merchants</option>{d.merchants.map((p: any) => <option value={p.id} selected={p.id === merchant}>{p.name}</option>)}</select>
      <button class="btn ghost sm" type="submit">Filter</button>
    </form>
    <Table head={["Waybill", "Merchant", "Consignee", "Emirate", ["COD", "num"], "Run", "Status"]} empty={d.rows.length ? undefined : "No parcels match."}>
      {d.rows.map((s: any) => <tr><td><a href={`${D}/shipments/${s.id}`}>{s.no}</a>{s.external_ref ? <div class="small mute">{s.external_ref}</div> : null}</td><td>{s.merchant_name}</td><td>{s.consignee_name}</td><td>{s.emirate}</td>
        <td class="num">{Number(s.cod_minor) ? <Money v={s.cod_minor} /> : "—"}</td><td>{s.run_no ?? "—"}</td><td><St s={s.status} /> {s.late ? <Badge s="bad" label="late" /> : null}</td></tr>)}
    </Table>
  </>));
});

delivery.get(`${D}/shipments/new`, async (c) => {
  need(c, "dlv.write");
  const merchants = await withT(c, (cn) => listParties(cn, "customer"));
  const csrf = c.get("csrf");
  return appPage(c, "New parcel", (<>
    <PageHead title="New parcel" sub="Merchants' orders normally arrive by CSV; use this for one-offs." />
    <form method="post" action={`${D}/shipments`} class="card" style="max-width:820px"><Csrf t={csrf} />
      <div class="row"><div class="field"><label for="m">Merchant</label><select id="m" name="merchant_id" required><option value="">— select —</option>{merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><label for="er">Merchant order reference</label><input id="er" name="external_ref" type="text" /></div></div>
      <div class="row"><div class="field"><label for="cn">Consignee name</label><input id="cn" name="consignee_name" type="text" required /></div>
        <div class="field"><label for="cp">Phone</label><input id="cp" name="consignee_phone" type="tel" /></div></div>
      <div class="field"><label for="ad">Delivery address</label><input id="ad" name="address" type="text" required /></div>
      <div class="row"><div class="field"><label for="em">Emirate</label><select id="em" name="emirate" required>{EMIRATES.map((e) => <option selected={e === "Dubai"}>{e}</option>)}</select></div>
        <div class="field"><label for="oe">Picked up in</label><select id="oe" name="origin_emirate">{EMIRATES.map((e) => <option selected={e === "Dubai"}>{e}</option>)}</select></div></div>
      <div class="row"><div class="field"><label for="cod">Cash to collect (AED, 0 = prepaid)</label><input id="cod" name="cod" type="number" step="0.01" min="0" max="50000" inputmode="decimal" /></div>
        <div class="field"><label for="pc">Pieces</label><input id="pc" name="pieces" type="number" min="1" value="1" /></div>
        <div class="field"><label for="wk">Weight (kg)</label><input id="wk" name="weight_kg" type="number" step="0.1" min="0" /></div></div>
      <div class="row"><div class="field"><label for="db">Deliver by</label><input id="db" name="deliver_by" type="datetime-local" /></div>
        <div class="field"><label for="ma">Maximum attempts</label><input id="ma" name="max_attempts" type="number" min="1" max="10" value="3" /></div></div>
      <div class="field"><label for="ds">Contents</label><input id="ds" name="description" type="text" /></div>
      <label class="check"><input type="checkbox" name="require_code" value="1" /><span>Rider must enter the 4-digit delivery code (recommended for high-value COD)</span></label>
      <button class="btn red" style="margin-top:12px" type="submit">Save parcel</button>
    </form>
  </>));
});
delivery.post(`${D}/shipments`, async (c) => {
  need(c, "dlv.write");
  const b = await formBody(c);
  return act(c, `${D}/shipments/new`, async () => {
    const r = await withT(c, (cn, ctx) => createShipment(cn, ctx, { ...b, require_code: str(b.require_code) }));
    return { to: `${D}/shipments/${r.id}`, ok: `Parcel ${r.no} saved.` };
  });
});

delivery.get(`${D}/shipments/import`, async (c) => {
  need(c, "dlv.write");
  const merchants = await withT(c, (cn) => listParties(cn, "customer"));
  const csrf = c.get("csrf");
  return appPage(c, "Import parcels", (<>
    <PageHead title="Import parcels (CSV)" />
    <section class="card" style="max-width:760px">
      <p class="small mute">One row per parcel. Required columns: <code>external_ref,consignee_name,address,emirate</code>. Optional: <code>consignee_phone,cod,pieces,weight_kg,description,origin_emirate,require_code,max_attempts</code>.
        <code>cod</code> is in AED (blank = prepaid). Emirate is one of {EMIRATES.join(", ")}. Known references are skipped, so re-uploading the same file is safe. Max 2,000 rows.</p>
      <form method="post" action={`${D}/shipments/import`} enctype="multipart/form-data"><Csrf t={csrf} />
        <div class="field"><label for="im">Merchant</label><select id="im" name="merchant_id" required><option value="">— select —</option>{merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><input name="file" type="file" accept=".csv,text/csv" required /></div>
        <label class="check" style="max-width:420px"><input type="checkbox" name="dry_run" /><span>Preview only (dry run, nothing saved)</span></label>
        <button class="btn ghost sm" style="margin-top:10px" type="submit">Import</button></form></section>
  </>));
});
delivery.post(`${D}/shipments/import`, async (c) => {
  need(c, "dlv.write");
  const b = await formBody(c);
  return act(c, `${D}/shipments/import`, async () => {
    const f = b.file;
    if (!(f instanceof File)) throw new HttpError(400, "Choose a CSV file.");
    if (f.size > 1_000_000) throw new HttpError(400, "CSV files are limited to 1 MB.");
    const dry = b.dry_run === "on", text = Buffer.from(await f.arrayBuffer()).toString("utf8");
    const r = await withT(c, (cn, ctx) => importShipments(cn, ctx, str(b.merchant_id), text, dry));
    return { to: dry ? `${D}/shipments/import` : `${D}/shipments`, ok: summarise(r, dry) };
  });
});

delivery.get(`${D}/shipments/:id`, async (c) => {
  need(c, "read");
  const id = c.req.param("id");
  const d = await withT(c, (cn) => getShipment(cn, id));
  const s = d.shipment, csrf = c.get("csrf"), w = can(c, "dlv.write");
  const k = d.collection;
  return appPage(c, s.no, (<>
    <PageHead title={`${s.no} · ${s.merchant_name}`} sub={`${s.consignee_name} · ${s.address}, ${s.emirate}`}><a class="btn ghost sm" href={`${D}/shipments`}>← Parcels</a></PageHead>
    <div class="grid g4">
      <div class="card"><h3>Status</h3><St s={s.status} /><p class="small mute" style="margin-top:6px">Attempts {s.attempts}/{s.max_attempts}{s.run_no ? ` · ${s.run_no} (${s.rider_name})` : ""}</p></div>
      <div class="card"><h3>Cash on delivery</h3><div class="kpi">{Number(s.cod_minor) ? <Money v={s.cod_minor} /> : "Prepaid"}</div>
        <p class="small mute">{k ? <>Collected {dt(k.collected_at)} · {k.remittance_no ? `paid out in ${k.remittance_no}` : k.settlement_no ? `counted in ${k.settlement_no}` : "with the rider"}</> : Number(s.cod_minor) ? "Not collected yet" : ""}</p></div>
      <div class="card"><h3>Contact</h3><p>{s.consignee_phone ?? "—"}</p><p class="small mute">Deliver by {dt(s.deliver_by)}</p></div>
      <div class="card"><h3>Delivery code</h3><div class="kpi">{s.delivery_code}</div><p class="small mute">{s.require_code ? "Rider must enter it" : "Optional"}</p></div>
    </div>
    {s.last_failure && ["undelivered", "return_to_sender"].includes(s.status) ? <div class="alert warn" style="margin-top:16px"><strong>Last attempt:</strong> {s.last_failure}</div> : null}
    {w ? (
      <div class="inline-form" style="margin:16px 0">
        {s.status === "new" ? <Confirm action={`${D}/shipments/${id}/cancel`} csrf={csrf} label="Cancel parcel" confirm="Cancel this parcel?" /> : null}
        {s.status === "undelivered" ? (<>
          <form method="post" action={`${D}/shipments/${id}/reattempt`} class="inline-form"><Csrf t={csrf} />
            <input name="consignee_phone" type="tel" placeholder="Corrected phone" /><input name="address" type="text" placeholder="Corrected address" /><button class="btn sm" type="submit">Re-attempt</button></form>
        </>) : null}
        {["new", "undelivered"].includes(s.status) ? (
          <form method="post" action={`${D}/shipments/${id}/rts`} class="inline-form" data-confirm="Send this parcel back to the merchant?"><Csrf t={csrf} />
            <input name="reason" type="text" placeholder="Reason" required /><button class="btn danger sm" type="submit">Return to merchant</button></form>) : null}
        {s.status === "return_to_sender" ? <PostBtn action={`${D}/shipments/${id}/returned`} csrf={csrf} label="Confirm it is back with the merchant" cls="red sm" /> : null}
      </div>) : null}
    <div class="grid g2" style="margin-top:16px;grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr))">
      <section><Table caption="History" head={["When", "What", "Detail"]}>
        {d.events.map((e: any) => <tr><td class="small">{dt(e.effective_time)}</td><td>{e.kind}{e.applied ? "" : " "}{e.applied ? null : <Badge s="warn" label="not applied" />}</td>
          <td class="small">{e.resolution ?? ""}{e.payload?.reason ? ` ${FAIL_REASONS[e.payload.reason] ?? e.payload.reason}` : ""}{e.payload?.name ? ` received by ${e.payload.name}` : ""}{e.actor ? ` · ${e.actor}` : ""}</td></tr>)}</Table></section>
      <section><Table caption="Charges" head={["Charge", ["Amount", "num"], "Billing"]} empty={d.charges.length ? undefined : "No charges yet."}>
        {d.charges.map((g: any) => <tr><td>{CHARGE_LABEL[g.charge_type]}</td><td class="num">{g.unrated ? "no rate yet" : <Money v={Math.round(Number(g.qty) * Number(g.unit_minor))} />}</td><td>{g.invoice_id ? <a href={`/app/invoices/${g.invoice_id}`}>invoiced</a> : "unbilled"}</td></tr>)}</Table></section>
    </div>
    <p class="small mute no-print" style="margin-top:14px"><a href={`${D}/labels?ids=${s.id}`} target="_blank">Print label</a></p>
    <p class="small mute" style="margin-top:14px">Public tracking link for the consignee (shows status only): <a href={`/t/${s.track_token}`}>/t/{s.track_token}</a></p>
  </>));
});
const shipPost = (path: string, ok: string, fn: (cn: any, ctx: any, id: string, b: any) => Promise<unknown>) =>
  delivery.post(`${D}/shipments/:id/${path}`, async (c) => {
    need(c, "dlv.write");
    const id = c.req.param("id"), b = await formBody(c);
    return act(c, `${D}/shipments/${id}`, async () => { await withT(c, (cn, ctx) => fn(cn, ctx, id, b)); return { to: `${D}/shipments/${id}`, ok }; });
  });
shipPost("cancel", "Parcel cancelled.", (cn, ctx, id) => cancelShipment(cn, ctx, id));
shipPost("reattempt", "Back in the queue for a new run.", (cn, ctx, id, b) => reattemptShipment(cn, ctx, id, b));
shipPost("rts", "Marked to be returned to the merchant.", (cn, ctx, id, b) => returnToSender(cn, ctx, id, str(b.reason)));
shipPost("returned", "Return confirmed; the return fee is accrued.", (cn, ctx, id) => confirmReturned(cn, ctx, id));

// ───────── runs
delivery.get(`${D}/runs`, async (c) => {
  need(c, "read");
  const rows = await withT(c, (cn) => listRuns(cn));
  return appPage(c, "Runs", (<>
    <PageHead title="Delivery runs" sub="One rider's load for one day. Cash is counted per rider, not per run.">{can(c, "dlv.write") ? <a class="btn red sm" href={`${D}/runs/new`}>New run</a> : null}</PageHead>
    <Table head={["Run", "Date", "Rider", "Parcels", "Delivered", "Failed", ["COD collected / due", "num"], "Status"]} empty={rows.length ? undefined : "No runs yet."}>
      {rows.map((r: any) => <tr><td><a href={`${D}/runs/${r.id}`}>{r.no}</a></td><td>{formatDay(r.run_date)}</td><td>{r.rider_name}</td><td>{r.parcels}</td><td>{r.delivered}</td><td>{r.failed}</td><td class="num"><Money v={r.collected_minor} /> / <Money v={r.cod_minor} /></td><td><Badge s={r.status === "out" ? "info" : r.status} /></td></tr>)}
    </Table>
  </>));
});
delivery.get(`${D}/runs/new`, async (c) => {
  need(c, "dlv.write");
  const d = await withT(c, async (cn) => ({
    riders: (await cn.query<any>(`SELECT d.*, (SELECT email FROM team_members m WHERE m.driver_id=d.id AND m.active LIMIT 1) AS login_email FROM drivers d WHERE active ORDER BY name`)).rows,
    parcels: await listShipments(cn, { status: "new", limit: 400 }),
  }));
  const csrf = c.get("csrf");
  return appPage(c, "New run", (<>
    <PageHead title="New run" />
    <form method="post" action={`${D}/runs`} class="card"><Csrf t={csrf} />
      <div class="row"><div class="field"><label for="rd">Rider</label><select id="rd" name="driver_id" required><option value="">— select —</option>{d.riders.map((r: any) => <option value={r.id}>{r.name}{r.login_email ? "" : " · no login"}</option>)}</select></div>
        <div class="field"><label for="dy">Date</label><input id="dy" name="run_date" type="date" /></div></div>
      {d.riders.length ? null : <p class="hint">Add riders under <a href={`${D}/riders`}>Riders</a> first.</p>}
      <Table caption="Parcels awaiting dispatch" head={["", "Waybill", "Merchant", "Consignee", "Emirate", ["COD", "num"]]} empty={d.parcels.length ? undefined : "Nothing is waiting."}>
        {d.parcels.map((p: any) => <tr><td><input type="checkbox" name="shipment_ids" value={p.id} aria-label={`Add ${p.no}`} /></td><td>{p.no}</td><td>{p.merchant_name}</td><td>{p.consignee_name}</td><td>{p.emirate}</td><td class="num">{Number(p.cod_minor) ? <Money v={p.cod_minor} /> : "—"}</td></tr>)}</Table>
      <button class="btn red" style="margin-top:12px" type="submit">Create run</button>
    </form>
  </>));
});
delivery.post(`${D}/runs`, async (c) => {
  need(c, "dlv.write");
  const b = await formBody(c);
  return act(c, `${D}/runs/new`, async () => {
    const r = await withT(c, (cn, ctx) => createRun(cn, ctx, { driver_id: str(b.driver_id), run_date: str(b.run_date) || undefined, shipment_ids: arr(b.shipment_ids) }));
    return { to: `${D}/runs/${r.id}`, ok: `Run ${r.no} created.` };
  });
});
delivery.get(`${D}/runs/:id`, async (c) => {
  need(c, "read");
  const id = c.req.param("id");
  const d = await withT(c, async (cn) => ({ ...(await getRun(cn, id)), free: await listShipments(cn, { status: "new", limit: 200 }) }));
  const r = d.run, csrf = c.get("csrf"), w = can(c, "dlv.write");
  const cod = d.shipments.reduce((a: number, s: any) => a + (s.status === "cancelled" ? 0 : Number(s.cod_minor)), 0);
  return appPage(c, r.no, (<>
    <PageHead title={`${r.no} · ${r.rider_name}`} sub={`${formatDay(r.run_date)} · ${d.shipments.length} parcel(s) · COD due ${fmtMoney(cod)}`}>
      <a class="btn ghost sm" href={`${D}/runs`}>← Runs</a><button class="btn ghost sm" type="button" data-print>Print manifest</button><a class="btn ghost sm" href={`${D}/labels?run=${id}`} target="_blank">Print labels</a>
    </PageHead>
    <p><Badge s={r.status === "out" ? "info" : r.status} /></p>
    {w ? (
      <div class="inline-form no-print" style="margin:12px 0">
        {r.status === "planned" ? <PostBtn action={`${D}/runs/${id}/start`} csrf={csrf} label="Send rider out" cls="red sm" /> : null}
        {r.status === "planned" && can(c, "dlv.approve") ? <form method="post" action={`${D}/runs/${id}/start`} class="inline-form"><Csrf t={csrf} /><input name="override" type="text" placeholder="Cash-hold override reason" aria-label="Cash-hold override reason" required /><button class="btn ghost sm" type="submit">Send out with override</button></form> : null}
        {r.status === "planned" ? <Confirm action={`${D}/runs/${id}/cancel`} csrf={csrf} label="Cancel run" confirm="Cancel this run and free its parcels?" /> : null}
        {r.status === "out" ? <PostBtn action={`${D}/runs/${id}/close`} csrf={csrf} label="Close run" cls="sm" /> : null}
      </div>) : null}
    <Table head={["#", "Waybill", "Consignee", "Address", "Phone", ["COD", "num"], "Status", ""]}>
      {d.shipments.map((s: any, i: number) => <tr><td>{i + 1}</td><td><a href={`${D}/shipments/${s.id}`}>{s.no}</a></td><td>{s.consignee_name}</td><td class="small">{s.address}, {s.emirate}</td><td>{s.consignee_phone ?? "—"}</td>
        <td class="num">{Number(s.cod_minor) ? <Money v={s.cod_minor} /> : "—"}</td><td><St s={s.status} /></td>
        <td class="no-print">{w && r.status === "planned" ? <PostBtn action={`${D}/runs/${id}/remove`} csrf={csrf} label="Remove" cls="ghost sm" fields={{ shipment_id: s.id }} /> : null}</td></tr>)}</Table>
    {w && ["planned", "out"].includes(r.status) && d.free.length ? (
      <form method="post" action={`${D}/runs/${id}/add`} class="card no-print" style="margin-top:16px"><Csrf t={csrf} />
        <h3>Add parcels</h3>
        <Table head={["", "Waybill", "Merchant", "Emirate", ["COD", "num"]]}>
          {d.free.map((p: any) => <tr><td><input type="checkbox" name="shipment_ids" value={p.id} aria-label={`Add ${p.no}`} /></td><td>{p.no}</td><td>{p.merchant_name}</td><td>{p.emirate}</td><td class="num">{Number(p.cod_minor) ? <Money v={p.cod_minor} /> : "—"}</td></tr>)}</Table>
        <button class="btn ghost sm" style="margin-top:10px" type="submit">Add selected</button></form>) : null}
  </>));
});
const runPost = (path: string, ok: string, to: (id: string) => string, fn: (cn: any, ctx: any, id: string, b: any) => Promise<unknown>) =>
  delivery.post(`${D}/runs/:id/${path}`, async (c) => {
    need(c, "dlv.write");
    const id = c.req.param("id"), b = await formBody(c);
    return act(c, `${D}/runs/${id}`, async () => { await withT(c, (cn, ctx) => fn(cn, ctx, id, b)); return { to: to(id), ok }; });
  });
runPost("add", "Parcels added.", (id) => `${D}/runs/${id}`, (cn, ctx, id, b) => addToRun(cn, ctx, id, arr(b.shipment_ids)));
runPost("remove", "Parcel taken off the run.", (id) => `${D}/runs/${id}`, (cn, ctx, id, b) => removeFromRun(cn, ctx, id, str(b.shipment_id)));
runPost("start", "The rider can now see the run on their phone.", (id) => `${D}/runs/${id}`, (cn, ctx, id, b) => startRun(cn, ctx, id, str(b.override) || undefined));
runPost("close", "Run closed.", (id) => `${D}/runs/${id}`, (cn, ctx, id) => closeRun(cn, ctx, id));
runPost("cancel", "Run cancelled.", () => `${D}/runs`, (cn, ctx, id) => cancelRun(cn, ctx, id));

// ───────── riders
delivery.get(`${D}/riders`, async (c) => {
  need(c, "read");
  const rows = await withT(c, async (cn) => (await cn.query<any>(`SELECT d.*, (SELECT email FROM team_members m WHERE m.driver_id=d.id AND m.active LIMIT 1) AS login_email FROM drivers d WHERE active ORDER BY name`)).rows);
  const csrf = c.get("csrf"), w = can(c, "dlv.write");
  return appPage(c, "Riders", (<>
    <PageHead title="Riders" sub="Riders sign in on their phone with a limited seat: they see only their own runs." />
    <Table head={["Name", "Phone", "Login"]} empty={rows.length ? undefined : "No riders yet."}>
      {rows.map((x: any) => <tr><td>{x.name}</td><td>{x.phone ?? "—"}</td>
        <td>{x.login_email ?? (can(c, "team.manage") ? <form method="post" action={`${D}/riders/login`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="driver_id" value={x.id} /><input name="email" type="email" placeholder="rider@email" required /><button class="btn ghost sm" type="submit">Invite</button></form> : <Badge s="warn" label="no login" />)}</td></tr>)}</Table>
    {w ? <form method="post" action={`${D}/riders`} class="inline-form" style="margin:10px 0 22px"><Csrf t={csrf} /><input name="name" type="text" placeholder="Rider name" required /><input name="phone" type="text" placeholder="Phone" /><button class="btn ghost sm" type="submit">Add rider</button></form> : null}
    {c.req.query("link") ? <div class="alert info">Invitation link: <code>/invite/{c.req.query("link")}</code> (emailed when mail is configured).</div> : null}
  </>));
});
delivery.post(`${D}/riders`, async (c) => {
  need(c, "dlv.write");
  const b = await formBody(c);
  return act(c, `${D}/riders`, async () => { await withT(c, (cn, ctx) => createRider(cn, ctx, b)); return { to: `${D}/riders`, ok: "Rider added." }; });
});
delivery.post(`${D}/riders/login`, async (c) => {
  need(c, "team.manage");
  const b = await formBody(c);
  return act(c, `${D}/riders`, async () => {
    const tok = await withT(c, (cn, ctx) => invite(cn, ctx, { email: str(b.email), roles: ["driver"], driver_id: str(b.driver_id) }));
    return { to: `${D}/riders?link=${tok}`, ok: "Rider invitation created." };
  });
});

// ───────── cash desk
delivery.get(`${D}/cash`, async (c) => {
  need(c, "read");
  const d = await withT(c, async (cn) => ({ cash: await cashInHand(cn), settlements: await listSettlements(cn), owed: await remittable(cn), rem: await listRemittances(cn), variances: await cashVariances(cn) }));
  const csrf = c.get("csrf"), cashier = can(c, "dlv.cash"), approver = can(c, "dlv.approve"), remit = can(c, "dlv.remit");
  const pending = d.settlements.filter((s: any) => s.status === "pending_approval");
  return appPage(c, "Cash desk", (<>
    <PageHead title="Cash desk" sub="Count each rider's cash against what the app says they collected. Merchants are paid what was collected; any difference stays on the record."><a class="btn ghost sm" href="/app/delivery/finance">Bank matching &amp; write-offs</a></PageHead>
    <Table caption="1 · Cash with riders (count it in)" head={["Rider", "Parcels", ["Expected", "num"], "Oldest", cashier ? "Count" : ""]} empty={d.cash.length ? undefined : "All cash is counted in."}>
      {d.cash.map((x: any) => <tr><td>{x.name}</td><td>{x.parcels}</td><td class="num"><Money v={x.amount_minor} /></td><td>{ageDays(x.oldest) >= 1 ? <Badge s="bad" label={`${ageDays(x.oldest)} day(s)`} /> : "today"}</td>
        <td>{cashier ? <form method="post" action={`${D}/cash/settle`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="driver_id" value={x.driver_id} />
          <input name="counted" type="number" step="0.01" min="0" placeholder="Counted AED" required aria-label={`Counted cash from ${x.name}`} /><input name="note" type="text" placeholder="Note (required if different)" /><button class="btn sm" type="submit">Receive</button></form> : null}</td></tr>)}</Table>
    {pending.length ? (<div style="margin-top:20px"><Table caption="2 · Differences waiting for a decision" head={["Handover", "Rider", ["Expected", "num"], ["Counted", "num"], ["Difference", "num"], "Note", approver ? "" : ""]}>
      {pending.map((s: any) => <tr><td>{s.no}</td><td>{s.rider_name}</td><td class="num"><Money v={s.expected_minor} /></td><td class="num"><Money v={s.counted_minor} /></td>
        <td class="num"><Badge s="bad" label={`${Number(s.variance_minor) > 0 ? "+" : ""}${(Number(s.variance_minor) / 100).toFixed(2)}`} /></td><td class="small">{s.note}</td>
        <td>{approver ? <div class="inline-form"><PostBtn action={`${D}/cash/settlements/${s.id}/approve`} csrf={csrf} label="Accept" cls="sm" /><PostBtn action={`${D}/cash/settlements/${s.id}/reject`} csrf={csrf} label="Recount" cls="ghost sm" /></div> : null}</td></tr>)}</Table></div>) : null}
    <div style="margin-top:20px"><Table caption="3 · Owed to merchants" head={["Merchant", "Parcels", ["COD counted in", "num"], ["Fees unbilled", "num"], remit ? "Prepare payout" : ""]} empty={d.owed.length ? undefined : "Nothing waiting."}>
      {d.owed.map((x: any) => <tr><td>{x.name}</td><td>{x.parcels}</td><td class="num"><Money v={x.gross_minor} /></td><td class="num"><Money v={x.unbilled_minor} /></td>
        <td>{remit ? <form method="post" action={`${D}/cash/remit`} class="inline-form"><Csrf t={csrf} /><input type="hidden" name="merchant_id" value={x.merchant_id} />
          {can(c, "finance.write") ? <label class="check"><input type="checkbox" name="net_fees" value="1" checked /><span>Net fees (VAT invoice)</span></label> : null}<button class="btn sm" type="submit">Prepare</button></form> : null}</td></tr>)}</Table></div>
    <div style="margin-top:20px"><Table caption="4 · Payout statements" head={["Statement", "Merchant", ["COD", "num"], ["Fees", "num"], ["Pay merchant", "num"], "Status", ""]} empty={d.rem.length ? undefined : "No statements yet."}>
      {d.rem.map((r: any) => <tr><td><a href={`${D}/cash/remittances/${r.id}`}>{r.no}</a></td><td>{r.merchant_name}</td><td class="num"><Money v={r.gross_minor} /></td><td class="num"><Money v={r.fees_minor} /></td><td class="num"><strong><Money v={r.net_minor} /></strong></td>
        <td><Badge s={r.status === "pending_payment" ? "pending" : r.status} label={r.status === "pending_payment" ? "to pay" : r.status} /></td>
        <td>{r.status === "pending_payment" ? <div class="inline-form">
          {approver ? <form method="post" action={`${D}/cash/remittances/${r.id}/pay`} class="inline-form"><Csrf t={csrf} /><input name="reference" type="text" placeholder="Bank transfer ref" required /><button class="btn sm" type="submit">Mark paid</button></form> : null}
          {remit && Number(r.fees_minor) === 0 ? <Confirm action={`${D}/cash/remittances/${r.id}/void`} csrf={csrf} label="Withdraw" confirm="Withdraw this statement?" cls="ghost sm" /> : null}</div> : r.pay_reference}</td></tr>)}</Table></div>
    <div style="margin-top:20px"><Table caption="Handover history" head={["Handover", "Rider", ["Expected", "num"], ["Counted", "num"], "Counted by", "Status"]} empty={d.settlements.length ? undefined : "None yet."}>
      {d.settlements.slice(0, 30).map((s: any) => <tr><td>{s.no}</td><td>{s.rider_name}</td><td class="num"><Money v={s.expected_minor} /></td><td class="num"><Money v={s.counted_minor} /></td><td>{s.received_name}</td><td><Badge s={s.status === "pending_approval" ? "pending" : s.status} label={s.status.replace(/_/g, " ")} /></td></tr>)}</Table></div>
    {d.variances.length ? <p class="small mute" style="margin-top:12px">Cash differences on record: {d.variances.length}, net {fmtMoney(d.variances.filter((v: any) => v.status === "closed").reduce((a: number, v: any) => a + Number(v.variance_minor), 0))} (negative = shortage the company absorbed).</p> : null}
  </>));
});
delivery.post(`${D}/cash/settle`, async (c) => {
  need(c, "dlv.cash");
  const b = await formBody(c);
  return act(c, `${D}/cash`, async () => {
    const r = await withT(c, (cn, ctx) => settleRider(cn, ctx, str(b.driver_id), { counted: str(b.counted), note: str(b.note) }));
    return { to: `${D}/cash`, ok: r.status === "closed" ? `${r.no}: counted in, no difference.` : `${r.no}: ${fmtMoney(Math.abs(r.variance))} ${r.variance < 0 ? "short" : "over"} — waiting for a second person to decide.` };
  });
});
delivery.post(`${D}/cash/settlements/:id/:decision`, async (c) => {
  need(c, "dlv.approve");
  const dec = c.req.param("decision");
  if (dec !== "approve" && dec !== "reject") throw new HttpError(404, "Not found");
  return act(c, `${D}/cash`, async () => { await withT(c, (cn, ctx) => decideSettlement(cn, ctx, c.req.param("id"), dec === "approve")); return { to: `${D}/cash`, ok: dec === "approve" ? "Difference accepted and recorded." : "Sent back for a recount." }; });
});
delivery.post(`${D}/cash/remit`, async (c) => {
  need(c, "dlv.remit");
  const b = await formBody(c);
  return act(c, `${D}/cash`, async () => {
    const r = await withT(c, (cn, ctx) => createRemittance(cn, ctx, str(b.merchant_id), { net_fees: str(b.net_fees) }));
    return { to: `${D}/cash/remittances/${r.id}`, ok: `${r.no}: pay the merchant ${fmtMoney(r.net)}${r.fees ? ` (COD ${fmtMoney(r.gross)} less fees ${fmtMoney(r.fees)} on ${r.invoiceNo})` : ""}.` };
  });
});
delivery.post(`${D}/cash/remittances/:id/pay`, async (c) => {
  need(c, "dlv.approve");
  const b = await formBody(c);
  return act(c, `${D}/cash`, async () => { await withT(c, (cn, ctx) => payRemittance(cn, ctx, c.req.param("id"), { reference: str(b.reference) })); return { to: `${D}/cash`, ok: "Payout recorded." }; });
});
delivery.post(`${D}/cash/remittances/:id/void`, async (c) => {
  need(c, "dlv.remit");
  return act(c, `${D}/cash`, async () => { await withT(c, (cn, ctx) => voidRemittance(cn, ctx, c.req.param("id"))); return { to: `${D}/cash`, ok: "Statement withdrawn; the cash is payable again." }; });
});
delivery.get(`${D}/cash/remittances/:id`, async (c) => {
  need(c, "read");
  const d = await withT(c, (cn) => getRemittance(cn, c.req.param("id")));
  const r = d.rm;
  return appPage(c, r.no, (<>
    <PageHead title={`COD remittance ${r.no}`} sub={r.merchant_name}><a class="btn ghost sm" href={`${D}/cash`}>← Cash desk</a><button class="btn ghost sm" type="button" data-print>Print</button></PageHead>
    <div class="grid g4">
      <div class="card"><h3>COD collected</h3><div class="kpi"><Money v={r.gross_minor} /></div></div>
      <div class="card"><h3>Fees netted</h3><div class="kpi"><Money v={r.fees_minor} /></div><p class="small mute">{r.invoice_no ? `Invoice ${r.invoice_no}` : "none"}</p></div>
      <div class="card"><h3>Pay merchant</h3><div class="kpi good"><Money v={r.net_minor} /></div></div>
      <div class="card"><h3>Status</h3><Badge s={r.status === "pending_payment" ? "pending" : r.status} label={r.status.replace(/_/g, " ")} /><p class="small mute">{r.pay_reference ? `Ref ${r.pay_reference}` : ""}</p></div>
    </div>
    <div style="margin-top:16px"><Table head={["Waybill", "Merchant ref", "Delivered", "Handover", ["COD", "num"]]}>
      {d.lines.map((l: any) => <tr><td>{l.no}</td><td>{l.external_ref ?? "—"}</td><td>{dt(l.delivered_at)}</td><td>{l.settlement_no}</td><td class="num"><Money v={l.amount_minor} /></td></tr>)}</Table></div>
  </>));
});

// ───────── rates & billing
delivery.get(`${D}/billing`, async (c) => {
  need(c, "dlv.bill");
  const d = await withT(c, async (cn) => ({ summary: await billingSummary(cn), rates: await listRates(cn), merchants: await listParties(cn, "customer") }));
  const csrf = c.get("csrf");
  return appPage(c, "Delivery billing", (<>
    <PageHead title="Rates & billing" sub="Charges accrue once per parcel as it is delivered or returned. Activity with no rate yet is kept and priced when you set one." />
    <Table caption="Unbilled activity" head={["Merchant", "Rated lines", ["Rated total (ex-VAT)", "num"], "Unrated", can(c, "finance.write") ? "" : ""]} empty={d.summary.length ? undefined : "Nothing unbilled."}>
      {d.summary.map((x: any) => <tr><td>{x.name}</td><td>{x.rated_lines}</td><td class="num"><Money v={x.rated_minor} /></td><td>{x.unrated_lines ? <Badge s="warn" label={`${x.unrated_lines} need a rate`} /> : "—"}</td>
        <td>{can(c, "finance.write") && x.rated_lines ? <PostBtn action={`${D}/billing/invoice`} csrf={csrf} label="Invoice" cls="sm" fields={{ merchant_id: x.id }} /> : null}</td></tr>)}</Table>
    <div style="margin-top:20px"><Table caption="Rate cards" head={["Merchant", "From", ["Delivery", "num"], ["Inter-emirate", "num"], ["Return", "num"], ["COD fee", "num"], "Tax"]} empty={d.rates.length ? undefined : "No rates set."}>
      {d.rates.map((r: any) => <tr><td>{r.merchant_name}</td><td>{formatDay(r.effective_from)}</td><td class="num"><Money v={r.delivery_minor} /></td><td class="num"><Money v={r.intercity_minor} /></td><td class="num"><Money v={r.return_minor} /></td>
        <td class="num">{(r.cod_fee_bps / 100).toFixed(2)}% (min <Money v={r.cod_fee_min_minor} />)</td><td>{r.tax_code}</td></tr>)}</Table></div>
    <form method="post" action={`${D}/billing/rate`} class="card" style="margin-top:20px;max-width:820px"><Csrf t={csrf} />
      <h3>Set a rate</h3>
      <div class="row"><div class="field"><label for="rm">Merchant</label><select id="rm" name="merchant_id" required><option value="">— select —</option>{d.merchants.map((p: any) => <option value={p.id}>{p.name}</option>)}</select></div>
        <div class="field"><label for="re">Effective from</label><input id="re" name="effective_from" type="date" /></div></div>
      <div class="row"><div class="field"><label for="r1">Delivery (AED / parcel)</label><input id="r1" name="delivery" type="number" step="0.01" min="0" /></div>
        <div class="field"><label for="r2">Inter-emirate extra</label><input id="r2" name="intercity" type="number" step="0.01" min="0" /></div>
        <div class="field"><label for="r3">Return fee</label><input id="r3" name="return" type="number" step="0.01" min="0" /></div></div>
      <div class="row"><div class="field"><label for="r4">COD fee (% of COD)</label><input id="r4" name="cod_fee_pct" type="number" step="0.01" min="0" max="20" /></div>
        <div class="field"><label for="r5">COD fee minimum (AED)</label><input id="r5" name="cod_fee_min" type="number" step="0.01" min="0" /></div>
        <div class="field"><label for="r6">Tax code</label><select id="r6" name="tax_code">{Object.entries(TAX_CODES).map(([k, v]) => <option value={k}>{k} — {v.label}</option>)}</select></div></div>
      <button class="btn red" type="submit">Save rate</button>
      <p class="small mute" style="margin-top:8px">Tax treatment is chosen per rate; have your accountant confirm it.</p>
    </form>
  </>));
});
delivery.post(`${D}/billing/rate`, async (c) => {
  need(c, "dlv.bill");
  const b = await formBody(c);
  return act(c, `${D}/billing`, async () => { const r = await withT(c, (cn, ctx) => setRate(cn, ctx, b)); return { to: `${D}/billing`, ok: r.priced ? `Rate saved; ${r.priced} earlier line(s) priced.` : "Rate saved." }; });
});
delivery.post(`${D}/billing/invoice`, async (c) => {
  need(c, "finance.write");
  const b = await formBody(c);
  return act(c, `${D}/billing`, async () => {
    const r = await withT(c, (cn, ctx) => invoiceMerchant(cn, ctx, str(b.merchant_id)));
    return { to: `${D}/billing`, ok: `Invoice ${r.no} issued for ${r.charges} line(s).${r.warnings.length ? " " + r.warnings.join(" ") : ""}` };
  });
});


// ───────── printable waybill labels (100 × 150 mm) with a Code 128 barcode of the waybill number
delivery.get(`${D}/labels`, async (c) => {
  need(c, "read");
  const ids = (c.req.query("ids") ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100), run = c.req.query("run") ?? "", fresh = c.req.query("status") === "new";
  const t = c.get("tenant")!;
  const rows = await withT(c, async (cn) => {
    if (run && /^[0-9a-f-]{36}$/i.test(run)) return (await getRun(cn, run)).shipments;
    if (fresh) return (await listShipments(cn, { status: "new", limit: 100 })).reverse();
    const out: any[] = [];
    for (const id of ids) out.push((await getShipment(cn, id)).shipment);
    return out;
  });
  return c.html(
    <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Labels</title><link rel="stylesheet" href="/assets/app.css" /><script src="/assets/app.js" defer></script>
      <style>{`@page{size:100mm 150mm;margin:0}body{background:#fff;margin:0}.lbl{box-sizing:border-box;width:100mm;height:150mm;padding:5mm;page-break-after:always;border-bottom:1px dashed #999;display:flex;flex-direction:column;gap:2mm;font:12px/1.3 system-ui,Arial,sans-serif;color:#000}
      .lbl h1{font-size:15px;margin:0}.lbl .big{font-size:20px;font-weight:800}.lbl .cod{border:3px solid #000;padding:2mm;text-align:center;font-size:22px;font-weight:900}.lbl .bc{text-align:center}.lbl .bc svg{width:90mm;height:22mm}.lbl .addr{font-size:15px;font-weight:700}
      @media screen{.lbl{margin:8px auto;border:1px solid #bbb}.bar{position:sticky;top:0;background:#071D35;color:#fff;padding:8px 16px}}@media print{.bar{display:none}.lbl{border:0}}`}</style></head>
    <body><div class="bar no-print">{rows.length} label(s) · <button class="btn sm" type="button" data-print>Print</button></div>
      {rows.map((s: any) => (
        <section class="lbl">
          <h1>{t.name}</h1>
          <div class="bc">{raw(barcodeSvg(s.no, { module: 2, height: 70 }))}<div class="big">{s.no}</div></div>
          <div class="cod">{Number(s.cod_minor) ? `COD  ${fmtMoney(Number(s.cod_minor))}` : "PREPAID"}</div>
          <div class="addr">{s.consignee_name}<br />{s.consignee_phone ?? ""}<br />{s.address}<br />{s.emirate}</div>
          <div>From: {s.merchant_name ?? ""}{s.external_ref ? ` · Ref ${s.external_ref}` : ""}</div>
          <div>{s.pieces} pc · {Number(s.weight_kg) ? `${Number(s.weight_kg)} kg` : ""}{s.deliver_by ? ` · by ${formatDate(s.deliver_by)}` : ""}{s.require_code ? " · CODE REQUIRED" : ""}</div>
          {s.description ? <div>{s.description}</div> : null}
        </section>))}
      {rows.length ? null : <p style="padding:20px">No labels to print.</p>}
    </body></html>);
});

// ───────── integrations: merchant API keys, webhook endpoints, SMS opt-in
const Integrations = (p: { csrf: string; keys: any[]; merchants: any[]; settings: any[]; newKey?: { key: string; name: string } | null; newSecret?: { secret: string; merchant: string } | null; base: string }) => (<>
  <PageHead title="Integrations" sub="Let a merchant's own systems create parcels and follow them, and push status changes to them as they happen." />
  {p.newKey ? <div class="alert ok"><strong>API key “{p.newKey.name}” created.</strong> Copy it now — it is shown once and only a fingerprint is kept.<br /><code style="user-select:all;word-break:break-all">{p.newKey.key}</code></div> : null}
  {p.newSecret ? <div class="alert ok"><strong>Webhook signing secret for {p.newSecret.merchant}.</strong> Copy it now — it is shown once.<br /><code style="user-select:all;word-break:break-all">{p.newSecret.secret}</code></div> : null}
  <Table caption="API keys" head={["Merchant", "Name", "Key", "Last used", "Status", ""]} empty={p.keys.length ? undefined : "No keys yet."}>
    {p.keys.map((k: any) => <tr><td>{k.merchant_name}</td><td>{k.name}</td><td><code>{k.prefix}…</code></td><td class="small">{k.last_used_at ? formatDate(k.last_used_at) : "never"}</td><td>{k.revoked_at ? <Badge s="void" label="revoked" /> : <Badge s="active" />}</td>
      <td>{k.revoked_at ? null : <Confirm action={`${D}/integrations/keys/${k.id}/revoke`} csrf={p.csrf} label="Revoke" confirm="Revoke this key? Systems using it stop working immediately." cls="ghost sm" />}</td></tr>)}</Table>
  <form method="post" action={`${D}/integrations/keys`} class="inline-form" style="margin:10px 0 24px"><Csrf t={p.csrf} />
    <select name="merchant_id" required aria-label="Merchant"><option value="">— merchant —</option>{p.merchants.map((m: any) => <option value={m.id}>{m.name}</option>)}</select>
    <input name="name" type="text" placeholder="Key name (e.g. Shopify sync)" required /><button class="btn sm" type="submit">Create key</button></form>
  <Table caption="Webhooks and SMS per merchant" head={["Merchant", "Webhook address (https)", "Active", "SMS to consignees", "WhatsApp notices", ""]}>
    {p.settings.map((m: any) => <tr><td>{m.name}</td>
      <td><form method="post" action={`${D}/integrations/webhook`} class="inline-form"><Csrf t={p.csrf} /><input type="hidden" name="merchant_id" value={m.merchant_id} /><input name="url" type="url" value={m.webhook_url} placeholder="https://merchant.example/hooks/loadbyton" style="min-width:280px" />
        <label class="check"><input type="checkbox" name="active" value="1" checked={m.webhook_active} /><span>on</span></label><label class="check"><input type="checkbox" name="rotate" value="1" /><span>new secret</span></label><button class="btn ghost sm" type="submit">Save</button></form></td>
      <td>{m.webhook_active ? <Badge s="active" label="on" /> : "off"}</td>
      <td><form method="post" action={`${D}/integrations/sms`} class="inline-form"><Csrf t={p.csrf} /><input type="hidden" name="merchant_id" value={m.merchant_id} /><label class="check"><input type="checkbox" name="on" value="1" checked={m.notify_sms} /><span>send</span></label><button class="btn ghost sm" type="submit">Save</button></form></td>
      <td><form method="post" action={`${D}/integrations/whatsapp`} class="inline-form"><Csrf t={p.csrf} /><input type="hidden" name="merchant_id" value={m.merchant_id} /><label class="check"><input type="checkbox" name="on" value="1" checked={m.notify_whatsapp} /><span>send</span></label><button class="btn ghost sm" type="submit">Save</button></form></td>
      <td>{m.webhook_active ? <PostBtn action={`${D}/integrations/webhook-test`} csrf={p.csrf} label="Send test" cls="ghost sm" fields={{ merchant_id: m.merchant_id }} /> : null}</td></tr>)}</Table>
  <p class="small mute">SMS and WhatsApp go to UAE mobile numbers only, for “out for delivery” and “could not deliver”; WhatsApp is sent only as Meta-approved templates. Turn it on only for merchants who have their customers' consent to be contacted; sender-ID registration with your SMS provider and UAE regulations are your responsibility.</p>
  <section class="card" style="margin-top:20px"><h3>API quick start</h3>
    <pre style="overflow:auto;font-size:.8rem;white-space:pre-wrap">{`curl -X POST ${p.base}/api/v1/parcels \
  -H "Authorization: Bearer lbtk_…" -H "Content-Type: application/json" \
  -d '{"reference":"ORDER-1001","consignee_name":"Aisha","consignee_phone":"0501234567","address":"Villa 4, Al Barsha","emirate":"Dubai","cod":249.5}'`}</pre>
    <p class="small">Endpoints: <code>POST /api/v1/parcels</code> (idempotent on <code>reference</code>) · <code>GET /api/v1/parcels?status=&amp;limit=&amp;before=</code> · <code>GET /api/v1/parcels/:waybill-or-reference</code> · <code>POST /api/v1/parcels/:id/cancel</code> (only before dispatch) · <code>GET /api/v1/remittances</code>. 120 requests/minute per key.</p>
    <p class="small">Webhooks: <code>POST</code> JSON <code>{`{id, type, created, data}`}</code> with header <code>LBT-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> where <code>v1 = HMAC-SHA256(secret, t + "." + rawBody)</code>. Reject if <code>t</code> is more than 5 minutes old; de-duplicate on <code>id</code>; answer 2xx within 10 s (otherwise we retry with back-off). Types: <code>parcel.out_for_delivery</code>, <code>parcel.delivered</code>, <code>parcel.attempt_failed</code>, <code>parcel.return_to_sender</code>, <code>parcel.returned</code>, <code>parcel.cancelled</code>, <code>remittance.paid</code>.</p></section>
</>);
delivery.get(`${D}/integrations`, async (c) => {
  need(c, "settings.manage");
  const d = await withT(c, async (cn) => ({ keys: await listApiKeys(cn), merchants: await listParties(cn, "customer"), settings: await listMerchantSettings(cn) }));
  return appPage(c, "Integrations", <Integrations csrf={c.get("csrf")} base={config.baseUrl.replace(/\/$/, "")} {...d} />);
});
delivery.post(`${D}/integrations/keys`, async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  try {
    const r = await withT(c, (cn, ctx) => createApiKey(cn, ctx, { merchant_id: str(b.merchant_id), name: str(b.name) }));
    const d = await withT(c, async (cn) => ({ keys: await listApiKeys(cn), merchants: await listParties(cn, "customer"), settings: await listMerchantSettings(cn) }));
    return appPage(c, "Integrations", <Integrations csrf={c.get("csrf")} base={config.baseUrl.replace(/\/$/, "")} {...d} newKey={{ key: r.key, name: str(b.name) }} />);   // rendered directly, never put in a URL
  } catch (e) { if (e instanceof HttpError && e.status < 500) return c.redirect(`${D}/integrations?err=${encodeURIComponent(e.message)}`); throw e; }
});
delivery.post(`${D}/integrations/keys/:id/revoke`, async (c) => {
  need(c, "settings.manage");
  return act(c, `${D}/integrations`, async () => { await withT(c, (cn, ctx) => revokeApiKey(cn, ctx, c.req.param("id"))); return { to: `${D}/integrations`, ok: "Key revoked." }; });
});
delivery.post(`${D}/integrations/webhook`, async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  try {
    const r = await withT(c, (cn, ctx) => setWebhook(cn, ctx, { merchant_id: str(b.merchant_id), url: str(b.url), active: str(b.active) === "1", rotate: str(b.rotate) === "1" }));
    if (!r.secret) return c.redirect(`${D}/integrations?ok=${encodeURIComponent("Webhook saved.")}`);
    const d = await withT(c, async (cn) => ({ keys: await listApiKeys(cn), merchants: await listParties(cn, "customer"), settings: await listMerchantSettings(cn) }));
    const name = d.merchants.find((m: any) => m.id === str(b.merchant_id))?.name ?? "merchant";
    return appPage(c, "Integrations", <Integrations csrf={c.get("csrf")} base={config.baseUrl.replace(/\/$/, "")} {...d} newSecret={{ secret: r.secret, merchant: name }} />);
  } catch (e) { if (e instanceof HttpError && e.status < 500) return c.redirect(`${D}/integrations?err=${encodeURIComponent(e.message)}`); throw e; }
});
delivery.post(`${D}/integrations/whatsapp`, async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  return act(c, `${D}/integrations`, async () => { await withT(c, (cn, ctx) => setNotifyWhatsApp(cn, ctx, str(b.merchant_id), str(b.on) === "1")); return { to: `${D}/integrations`, ok: "WhatsApp setting saved." }; });
});
delivery.post(`${D}/integrations/sms`, async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  return act(c, `${D}/integrations`, async () => { await withT(c, (cn, ctx) => setNotifySms(cn, ctx, str(b.merchant_id), str(b.on) === "1")); return { to: `${D}/integrations`, ok: "SMS setting saved." }; });
});
delivery.post(`${D}/integrations/webhook-test`, async (c) => {
  need(c, "settings.manage");
  const b = await formBody(c);
  return act(c, `${D}/integrations`, async () => { await withT(c, (cn, ctx) => sendTestWebhook(cn, ctx, str(b.merchant_id))); return { to: `${D}/integrations`, ok: "Test event queued; it is delivered within seconds." }; });
});

// ───────── public tracking: no login, no personal data (a token is the capability)
export const deliveryPublic = new Hono<Env>();
deliveryPublic.get("/t/:token", async (c) => {
  const ip = clientIp(c);
  await rateLimit(`track:${ip || "unknown"}`, ip ? 60 : 600, 60, "Too many lookups. Please wait a minute and try again.");   // the token is unguessable; this stops scanning
  const t = await trackByToken(c.get("db"), c.req.param("token"));
  const p = { title: "Track your parcel", csrf: c.get("csrf"), path: c.req.path, user: null };
  if (!t) return c.html(<PublicShell p={p}><section class="block"><div class="wrap prose"><h1>Parcel not found</h1><p>Check the tracking link you were sent.</p></div></section></PublicShell>, 404);
  const done = t.status === "delivered";
  return c.html(
    <PublicShell p={{ ...p, description: `Status of parcel ${t.no}` }}>
      <section class="block"><div class="wrap prose">
        <h1>Parcel {t.no}</h1>
        <p>Sent by <strong>{t.merchant}</strong> to {t.emirate}.</p>
        <p><Badge s={BADGE[t.status] ?? t.status} label={STATUS_LABEL[t.status] ?? t.status} /></p>
        {t.cod_minor && !done && ["new", "assigned", "out_for_delivery", "undelivered"].includes(t.status) ? <div class="alert info">Please have <strong>{fmtMoney(t.cod_minor)}</strong> ready for the rider (cash on delivery).</div> : null}
        <ol>{t.steps.map((s) => <li><strong>{formatDate(s.at)}</strong> — {s.text}</li>)}</ol>
        <p class="small mute">For your privacy this page never shows your name, address or phone number.</p>
      </div></section>
    </PublicShell>);
});
