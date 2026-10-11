/**
 * Plain-language reading of the management report, produced by fixed rules from the figures themselves. There is no model: the same
 * figures always give the same sentences, each sentence names the figures it rests on, and it says what the numbers show — never why
 * they happened. A person decides what to do.
 */
export interface Insight { severity: "attention" | "info"; area: string; text: string; figures: Record<string, string | number>; link: string }
type Report = Awaited<ReturnType<typeof import("./reports.js").managementReports>>;

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const money = (minor: number, ccy: string) => `${ccy} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function explainReport(d: Report): Insight[] {
  const out: Insight[] = [];
  for (const f of d.finance) {
    const issued = Number(f.issued), collected = Number(f.collected), outstanding = Number(f.outstanding), overdue = Number(f.overdue);
    if (outstanding > 0 && pct(overdue, outstanding) >= 50)
      out.push({ severity: "attention", area: "Collections", text: `${pct(overdue, outstanding)}% of the ${money(outstanding, f.currency)} outstanding is past its due date (${money(overdue, f.currency)}).`, figures: { currency: f.currency, outstanding, overdue, overdue_share_pct: pct(overdue, outstanding) }, link: "/app/invoices?filter=overdue" });
    else if (outstanding > 0)
      out.push({ severity: "info", area: "Collections", text: `${money(outstanding, f.currency)} is outstanding; ${overdue > 0 ? `${money(overdue, f.currency)} of it is overdue` : "none of it is overdue"}.`, figures: { currency: f.currency, outstanding, overdue }, link: "/app/invoices" });
    if (issued > 0 && collected / issued < 0.5 && f.invoices >= 5)
      out.push({ severity: "attention", area: "Collections", text: `Only ${pct(collected, issued)}% of the ${money(issued, f.currency)} invoiced has been collected across ${plural(f.invoices, "invoice")}.`, figures: { currency: f.currency, issued, collected, invoices: f.invoices }, link: "/app/invoices" });
    if (f.unsynchronized > 0)
      out.push({ severity: "attention", area: "Accounting", text: `${plural(f.unsynchronized, "invoice")} in ${f.currency} ${f.unsynchronized === 1 ? "is" : "are"} not synchronised to the accounting system.`, figures: { currency: f.currency, unsynchronised: f.unsynchronized }, link: "/app/invoices" });
  }
  const lostTotal = d.lost.reduce((a, r) => a + Number(r.records), 0);
  if (lostTotal >= 3 && d.lost[0]) {
    const top = d.lost[0];
    out.push({ severity: "info", area: "Sales", text: `${plural(lostTotal, "enquiry")} ${lostTotal === 1 ? "was" : "were"} lost; the most recorded reason is “${top.reason}” (${top.records} of ${lostTotal}, ${pct(Number(top.records), lostTotal)}%).`, figures: { lost: lostTotal, top_reason: top.reason, top_count: Number(top.records) }, link: "/app/enquiries" });
  }
  const open = d.sales.filter((s) => ["new", "qualified"].includes(s.status)).reduce((a, r) => a + Number(r.records), 0);
  if (open > 0) out.push({ severity: "info", area: "Sales", text: `${plural(open, "enquiry")} ${open === 1 ? "has" : "have"} not been quoted yet.`, figures: { unquoted: open }, link: "/app/enquiries" });
  const missing = d.transport.reduce((a, r) => a + Number(r.distance_missing), 0), trips = d.transport.reduce((a, r) => a + Number(r.trips), 0);
  if (missing > 0) out.push({ severity: "attention", area: "Transport", text: `${missing} of ${trips} trips have no recorded actual distance, so kilometre figures understate the work done.`, figures: { trips, distance_missing: missing }, link: "/app/transport/trips" });
  for (const w of d.warehouse) {
    const stock = Number(w.stock), old = Number(w.over_90_days);
    if (stock > 0 && pct(old, stock) >= 25) out.push({ severity: "attention", area: "Warehouse", text: `${pct(old, stock)}% of ${w.owner}'s stock (${old} of ${stock} units) has been in place for over 90 days.`, figures: { owner: w.owner, stock, over_90_days: old }, link: "/app/warehouse/stock" });
  }
  const full = d.utilization.filter((u) => u.capacity_units != null && Number(u.capacity_units) > 0 && Number(u.used) / Number(u.capacity_units) >= 0.95);
  if (full.length) out.push({ severity: "info", area: "Warehouse", text: `${plural(full.length, "location")} ${full.length === 1 ? "is" : "are"} at 95% or more of capacity: ${full.slice(0, 5).map((u) => u.code).join(", ")}${full.length > 5 ? "…" : ""}.`, figures: { locations: full.length }, link: "/app/warehouse/stock" });
  if (d.accuracy.approved_lines >= 10) {
    const acc = pct(d.accuracy.exact_lines, d.accuracy.approved_lines);
    out.push({ severity: acc < 98 ? "attention" : "info", area: "Warehouse", text: `Stock-count accuracy is ${acc}% (${d.accuracy.exact_lines} of ${d.accuracy.approved_lines} approved count lines matched the system).`, figures: { approved_lines: d.accuracy.approved_lines, exact_lines: d.accuracy.exact_lines }, link: "/app/warehouse/counts" });
  }
  if (d.service.overdue > 0) out.push({ severity: "attention", area: "Inbox", text: `${plural(d.service.overdue, "open conversation")} ${d.service.overdue === 1 ? "is" : "are"} past the response target.`, figures: { overdue: d.service.overdue, open: d.service.open }, link: "/app/inbox" });
  if (d.service.unaccepted > 0) out.push({ severity: "attention", area: "Inbox", text: `${plural(d.service.unaccepted, "conversation")} ${d.service.unaccepted === 1 ? "has" : "have"} no owner who has accepted ${d.service.unaccepted === 1 ? "it" : "them"}.`, figures: { unaccepted: d.service.unaccepted }, link: "/app/inbox" });
  const hold = d.specialist.filter((s) => s.status === "hold").reduce((a, r) => a + Number(r.cases), 0);
  if (hold > 0) out.push({ severity: "attention", area: "Specialist", text: `${plural(hold, "specialist case")} ${hold === 1 ? "is" : "are"} on hold.`, figures: { on_hold: hold }, link: "/app/reports" });
  return out.sort((a, b) => (a.severity === b.severity ? a.area.localeCompare(b.area) : a.severity === "attention" ? -1 : 1));
}
