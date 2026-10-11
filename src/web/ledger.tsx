import { Hono } from "hono";
import { addAccount, accountLedger, decideManualEntry, enableLedger, journalDetail, ledgerReconciliation, ledgerSettings, listAccounts, listJournals, listManualEntries, postLedgerNow, proposeManualEntry, trialBalance } from "../ops/ledger.js";
import { today } from "../ops/common.js";
import { act, appPage, can, need, PageHead, withT } from "./appkit.js";
import { Badge, Csrf, Money, Table } from "./ui.js";
import { formBody, str, type Env } from "./mw.js";

export const ledger = new Hono<Env>();
const U = "/app/finance/ledger";
const field = (id: string, text: string, extra: Record<string, any> = {}) => <div class="field"><label for={id}>{text}</label><input id={id} name={id} {...extra} /></div>;
const NOTE = "A bookkeeping ledger built from your invoices, receipts, credit notes and supplier bills. It is not a statutory financial statement: your accountant owns the chart of accounts, period close, VAT filing and audit.";

ledger.get(U, async (c) => {
  need(c, "finance.write");
  const csrf = c.get("csrf");
  const d = await withT(c, async (cn) => {
    const settings = await ledgerSettings(cn);
    return settings ? { settings, tb: await trialBalance(cn, c.req.query("as_of") || today()), rec: await ledgerReconciliation(cn), accounts: await listAccounts(cn), entries: await listManualEntries(cn), journals: await listJournals(cn, 30) } : { settings: null } as any;
  });
  if (!d.settings) return appPage(c, "General ledger", <>
    <PageHead title="General ledger" sub={NOTE} />
    {can(c, "settings.manage") ? <form class="card" method="post" action={`${U}/enable`}><Csrf t={csrf} /><h2>Enable the ledger</h2>
      {field("start_date", "Start date (the ledger holds nothing earlier; enter earlier balances as an opening-balance entry)", { type: "date", value: today(), max: today(), required: true })}
      <p class="small mute">The start date cannot be changed afterwards.</p><button class="btn">Enable general ledger</button></form> : <p>The general ledger has not been enabled by the owner.</p>}</>);
  const open = d.entries.filter((e: any) => e.status === "proposed");
  return appPage(c, "General ledger", <>
    <PageHead title="General ledger" sub={`${NOTE} Started ${String(d.settings.start_date).slice(0, 10)}.`}>
      <form method="post" action={`${U}/post`}><Csrf t={csrf} /><button class="btn sm">Post pending now</button></form></PageHead>
    {d.rec ? <div class={`alert ${d.rec.ok ? "good" : "warn"}`}>{d.rec.ok ? "The receivable and payable control accounts agree with the sub-ledgers." : <>Sub-ledger check: {d.rec.pending ? `${d.rec.pending} source record(s) are not journalled yet. ` : ""}{d.rec.items.filter((x: any) => x.difference !== 0).map((x: any) => `${x.name}: ledger ${(x.ledger / 100).toFixed(2)} vs sub-ledger ${(x.subledger / 100).toFixed(2)}. `)}</>}</div> : null}
    <h2>Trial balance as of {d.tb.asOf}</h2>
    <Table head={["Account", "Type", ["Debit", "num"], ["Credit", "num"], ["Balance", "num"]]}>
      {d.tb.rows.map((r: any) => <tr><td><a href={`${U}/accounts/${r.id}`}>{r.code} · {r.name}</a></td><td>{r.kind}</td><td class="num"><Money v={r.debit} /></td><td class="num"><Money v={r.credit} /></td><td class="num"><Money v={r.balance} /></td></tr>)}
      <tr><th colspan={2}>Total</th><th class="num"><Money v={d.tb.debit} /></th><th class="num"><Money v={d.tb.credit} /></th><th>{d.tb.balanced ? <Badge s="ok" label="balanced" /> : <Badge s="bad" label="OUT OF BALANCE" />}</th></tr>
    </Table>
    <h2>Recent journals</h2>
    <Table head={["No.", "Date", "Source", "Memo", ["Amount", "num"]]} empty="Nothing posted yet.">
      {d.journals.map((j: any) => <tr><td><a href={`${U}/journals/${j.id}`}>{j.no}</a></td><td>{String(j.posted_on).slice(0, 10)}</td><td>{j.source_type.replace(/_/g, " ")}</td><td>{j.memo}</td><td class="num"><Money v={j.amount} /></td></tr>)}</Table>
    <h2>Manual entries</h2>
    <Table head={["Date", "Explanation", "Status", ""]} empty="No manual entries.">
      {d.entries.map((e: any) => <tr><td>{String(e.entry_date).slice(0, 10)}</td><td>{e.memo}<div class="small mute">proposed by {e.proposer ?? "—"}</div></td><td><Badge s={e.status === "approved" ? "ok" : e.status === "rejected" ? "bad" : "warn"} label={e.status} /></td>
        <td>{e.status === "proposed" && can(c, "finance.void") ? <><form method="post" action={`${U}/entries/${e.id}/approve`} class="inline-form"><Csrf t={csrf} /><button class="btn sm">Approve and post</button></form> <form method="post" action={`${U}/entries/${e.id}/reject`} class="inline-form"><Csrf t={csrf} /><button class="btn ghost sm">Reject</button></form></> : null}</td></tr>)}</Table>
    <form class="card" method="post" action={`${U}/entries`}><Csrf t={csrf} /><h2>Propose a manual entry</h2><p class="small mute">Another person approves it before it is posted. Each line is a debit or a credit; the entry must balance.{open.length ? ` ${open.length} awaiting approval.` : ""}</p>
      {field("entry_date", "Date", { type: "date", value: today(), max: today(), required: true })}{field("memo", "Explanation", { required: true })}
      {[1, 2, 3, 4].map((i) => <div class="inline-form"><select name={`account_${i}`} aria-label={`Account ${i}`}><option value="">—</option>{d.accounts.filter((a: any) => a.active).map((a: any) => <option value={a.id}>{a.code} · {a.name}</option>)}</select>
        <input name={`debit_${i}`} type="number" step="0.01" min="0" placeholder="Debit" /><input name={`credit_${i}`} type="number" step="0.01" min="0" placeholder="Credit" /></div>)}
      <button class="btn">Propose entry</button></form>
    {can(c, "settings.manage") ? <form class="card" method="post" action={`${U}/accounts`}><Csrf t={csrf} /><h2>Add an account</h2>{field("code", "Code", { required: true, maxlength: "12" })}{field("name", "Name", { required: true })}
      <div class="field"><label for="kind">Type</label><select id="kind" name="kind">{["asset", "liability", "equity", "income", "expense"].map((k) => <option>{k}</option>)}</select></div><button class="btn">Add account</button></form> : null}</>);
});
ledger.post(`${U}/enable`, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => enableLedger(cn, ctx, str(b.start_date))); return { to: U, ok: "General ledger enabled." }; }); });
ledger.post(`${U}/post`, async (c) => act(c, U, async () => { const n = await withT(c, (cn, ctx) => postLedgerNow(cn, ctx)); return { to: U, ok: `${n} journal${n === 1 ? "" : "s"} posted.` }; }));
ledger.post(`${U}/accounts`, async (c) => { const b = await formBody(c); return act(c, U, async () => { await withT(c, (cn, ctx) => addAccount(cn, ctx, b)); return { to: U, ok: "Account added." }; }); });
ledger.post(`${U}/entries`, async (c) => {
  const b = await formBody(c);
  const lines = [1, 2, 3, 4].map((i) => ({ account_id: str(b[`account_${i}`]), debit: str(b[`debit_${i}`]), credit: str(b[`credit_${i}`]) })).filter((l) => l.account_id || l.debit || l.credit);
  return act(c, U, async () => { await withT(c, (cn, ctx) => proposeManualEntry(cn, ctx, { entry_date: str(b.entry_date), memo: str(b.memo), lines })); return { to: U, ok: "Entry proposed. Another person must approve it." }; });
});
for (const [path, approve, ok] of [["approve", true, "Entry approved and posted."], ["reject", false, "Entry rejected."]] as const)
  ledger.post(`${U}/entries/:id/${path}`, async (c) => { const id = c.req.param("id"); return act(c, U, async () => { await withT(c, (cn, ctx) => decideManualEntry(cn, ctx, id, approve)); return { to: U, ok }; }); });
ledger.get(`${U}/accounts/:id`, async (c) => {
  need(c, "finance.write");
  const d = await withT(c, (cn) => accountLedger(cn, c.req.param("id")));
  return appPage(c, `${d.account.code} ${d.account.name}`, <><PageHead title={`${d.account.code} · ${d.account.name}`} sub={d.account.kind} />
    <Table head={["Date", "Journal", "Memo", ["Debit", "num"], ["Credit", "num"], ["Balance", "num"]]} empty="No postings.">
      {d.lines.map((l: any) => <tr><td>{String(l.posted_on).slice(0, 10)}</td><td>{l.no}</td><td>{l.memo}</td><td class="num">{l.debit ? <Money v={l.debit} /> : ""}</td><td class="num">{l.credit ? <Money v={l.credit} /> : ""}</td><td class="num"><Money v={l.balance} /></td></tr>)}</Table><p><a href={U}>Back</a></p></>);
});
ledger.get(`${U}/journals/:id`, async (c) => {
  need(c, "finance.write");
  const d = await withT(c, (cn) => journalDetail(cn, c.req.param("id")));
  return appPage(c, `Journal ${d.journal.no}`, <><PageHead title={`Journal ${d.journal.no}`} sub={`${String(d.journal.posted_on).slice(0, 10)} · ${d.journal.memo}`} />
    <Table head={["Account", ["Debit", "num"], ["Credit", "num"]]}>{d.lines.map((l: any) => <tr><td>{l.code} · {l.name}</td><td class="num">{Number(l.debit_minor) ? <Money v={Number(l.debit_minor)} /> : ""}</td><td class="num">{Number(l.credit_minor) ? <Money v={Number(l.credit_minor)} /> : ""}</td></tr>)}</Table><p><a href={U}>Back</a></p></>);
});
