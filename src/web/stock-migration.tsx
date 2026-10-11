import { Hono } from "hono";
import { applyStockMigration, getStockMigration, listStockMigrations, stageStockMigration } from "../ops/stock-migration.js";
import { act, appPage, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";
import { formatDate } from "../lib/util.js";

export const stockMigration = new Hono<Env>();

stockMigration.get("/app/migration/stock", async (c) => {
  need(c, "settings.manage");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => ({
    rows: await listStockMigrations(cn),
    docs: (await cn.query<any>(`SELECT id,title FROM documents WHERE mime='text/csv' AND status='issued' AND NOT hold ORDER BY created_at DESC LIMIT 300`)).rows,
  }));
  return appPage(c, "Stock opening balances", <>
    <PageHead title="Stock opening balances" sub="Load the old system's counted stock, reconcile it to a declared control total, and apply only the difference — after a second person approves." />
    <p class="small mute">Fulfilment columns: sku_code, location_code, qty. Custody columns: owner, sku_code, location_code, lot, qty. Lot/serial-tracked fulfilment SKUs load through lot receipts. Stage the same file format again at cutover for the final delta; positions not in a later file are left unchanged.</p>
    <form class="card" method="post" action="/app/migration/stock">
      <Csrf t={csrf} />
      <div class="field"><label for="module">Stock held in</label><select id="module" name="module"><option value="fulfilment">Fulfilment</option><option value="custody">Custody warehouse</option></select></div>
      <div class="field"><label for="doc">Issued CSV snapshot</label><select id="doc" name="document_id" required>{d.docs.map((x: any) => <option value={x.id}>{x.title}</option>)}</select></div>
      <div class="field"><label for="control">Control total (units in the old system)</label><input id="control" name="control_units" type="number" step="0.001" min="0" required /></div>
      <div class="field"><label for="purpose">Cutover scope and fallback</label><input id="purpose" name="purpose" required /></div>
      <button class="btn">Stage and compare</button>
    </form>
    {d.rows.map((r: any) => <section class="card">
      <h2>{r.module} · {r.purpose} · <Badge s={r.status} /></h2>
      <p class="small">Staged {formatDate(r.created_at)}. File total {r.summary.total_units} of declared {r.summary.control_units}. Changes {r.summary.changes}, unchanged {r.summary.unchanged}, net {r.summary.net_delta}{r.summary.posted != null ? `, posted ${r.summary.posted}` : ""}.</p>
      {(r.summary.errors ?? []).map((e: string) => <p class="bad small">{e}</p>)}
      {r.status === "validated" && !(r.summary.errors ?? []).length ? <form method="post" action={`/app/migration/stock/${r.id}/apply`}>
        <Csrf t={csrf} /><div class="field"><label for={`ev-${r.id}`}>Counted, signed-off evidence and fallback</label><input id={`ev-${r.id}`} name="evidence" required /></div><button class="btn">Apply as adjustments</button></form> : null}
    </section>)}
  </>);
});

stockMigration.get("/app/migration/stock/:id", async (c) => {
  need(c, "settings.manage");
  const b = await withT(c, (cn) => getStockMigration(cn, c.req.param("id")));
  return appPage(c, "Stock migration", <>
    <PageHead title="Stock migration comparison" sub={`${b.module} · ${b.status}`} />
    <Table head={["Position", ["Current", "num"], ["Snapshot", "num"], ["Change", "num"]]}>
      {(b.diff as any[]).map((r) => <tr><td>{r.label}</td><td>{r.current}</td><td>{r.target}</td><td class={r.problem ? "bad" : ""}>{r.delta}{r.problem ? ` — ${r.problem}` : ""}</td></tr>)}
    </Table>
  </>);
});

stockMigration.post("/app/migration/stock", async (c) => {
  const b = await formBody(c);
  return act(c, "/app/migration/stock", async () => {
    await withT(c, (cn, ctx) => stageStockMigration(cn, ctx, str(b.module) as any, str(b.document_id), str(b.purpose), Number(str(b.control_units))));
    return { to: "/app/migration/stock", ok: "Snapshot staged and compared." };
  });
});
stockMigration.post("/app/migration/stock/:id/apply", async (c) => {
  const b = await formBody(c), id = c.req.param("id");
  return act(c, "/app/migration/stock", async () => {
    await withT(c, (cn, ctx) => applyStockMigration(cn, ctx, id, str(b.evidence)));
    return { to: "/app/migration/stock", ok: "Stock adjusted to the snapshot." };
  });
});
