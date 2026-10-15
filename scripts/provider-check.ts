// Sandbox acceptance for provider connections. Usage: npm run provider-check -- <dhl|google-routes|orders> [options]
// It makes REAL calls with credentials you supply in the environment, prints a pass/fail checklist and a short evidence report. Run it against the provider's TEST account first.
//   dhl:           DHL_USER, DHL_PASS, DHL_ACCOUNT, (DHL_ENV=test|live, default test) — books one domestic test shipment and checks the returned label is a PDF.
//   google-routes: ROUTING_API_KEY — asks for a 3-stop traffic-aware matrix.
//   orders:        ORDERS_PROFILE=magento|amazon, ORDERS_URL, ORDERS_TOKEN — reads the first page of orders and checks that each maps to a valid fulfilment order.
import { bookDhl } from "../src/adapters/carrier-dhl.js";
import { googleMatrix } from "../src/ops/road-matrix.js";
import { mapPulledOrder, parseFieldMap } from "../src/ops/order-pull.js";
import { ORDER_PROFILES } from "../src/ops/order-profiles.js";
import { pick } from "../src/ops/live-feeds.js";

type Check = { name: string; ok: boolean; detail?: string };
const out: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => { out.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`Set ${k}.`); process.exit(2); } return v; };
const which = process.argv[2];

async function dhl() {
  const env = process.env.DHL_ENV === "live" ? "live" : "test";
  if (env === "live") { console.error("Refusing to book a real shipment. Use DHL_ENV=test."); process.exit(2); }
  const party = { name: "Sandbox Test", phone: "0500000000", address1: "Test address 1", city: "Dubai", country: "AE" };
  try {
    const r = await bookDhl({ environment: env, username: need("DHL_USER"), password: need("DHL_PASS") }, { reference: `CHECK-${Date.now()}`, shipper: { ...party, company: "Sandbox Shipper" }, receiver: party, weightKg: 0.5, description: "Test parcel", productCode: process.env.DHL_PRODUCT ?? "N", accountNumber: need("DHL_ACCOUNT"), shipDate: new Date() });
    check("DHL accepted a domestic test shipment", true, r.trackingNo);
    check("label is a PDF", r.label.data.subarray(0, 4).toString() === "%PDF", `${r.label.data.length} bytes`);
  } catch (e: any) { check("DHL accepted a domestic test shipment", false, e.message); }
}
async function google() {
  const pts = [{ lat: 25.2048, lng: 55.2708 }, { lat: 25.0657, lng: 55.1713 }, { lat: 24.9857, lng: 55.0272 }];
  process.env.ROUTING_PROVIDER = "google"; process.env.ROUTING_API_KEY = need("ROUTING_API_KEY");
  try {
    const m = await googleMatrix(pts, (url: string, headers: Record<string, string>, body?: string) => fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body }).then(async (r) => ({ status: r.status, body: await r.text() })) as any);
    check("matrix returned for 3 stops", m.duration.length === 3 && m.distance.length === 3);
    check("traffic-aware flag set", m.traffic === true);
    check("durations plausible (Dubai→Jebel Ali 10–90 min)", m.duration[0][2] > 600 && m.duration[0][2] < 5400, `${Math.round(m.duration[0][2] / 60)} min`);
  } catch (e: any) { check("matrix returned for 3 stops", false, e.message); }
}
async function orders() {
  const prof = ORDER_PROFILES[need("ORDERS_PROFILE")];
  if (!prof) { console.error(`Profile is one of ${Object.keys(ORDER_PROFILES).join(", ")}.`); process.exit(2); }
  const f = { ...prof.defaults };
  const map = parseFieldMap(f);
  const u = new URL(need("ORDERS_URL"));
  for (const [k, v] of Object.entries(f.static_params ?? {})) u.searchParams.set(k, String(v));
  const res = await fetch(u, { headers: { authorization: `Bearer ${need("ORDERS_TOKEN")}`, accept: "application/json" } });
  check("provider answered 200", res.status === 200, String(res.status));
  if (res.status !== 200) return;
  const json = await res.json().catch(() => null);
  const items = pick(json, f.items_path ?? "") as unknown[];
  check("order list found at the profile's path", Array.isArray(items), String(f.items_path ?? "(root)"));
  if (!Array.isArray(items)) return;
  const kinds = items.map((o) => mapPulledOrder(o, map).kind);
  const bad = items.map((o) => mapPulledOrder(o, map)).filter((m) => m.kind === "invalid") as { reason: string }[];
  check("sampled orders map without an invalid result", bad.length === 0, `${items.length} orders; ${kinds.filter((k) => k === "order").length} ship, ${kinds.filter((k) => k === "cancel").length} cancel, ${kinds.filter((k) => k === "skip").length} skipped${bad.length ? `; first problem: ${bad[0].reason}` : ""}`);
}

const run = { dhl, "google-routes": google, orders }[which as string];
if (!run) { console.error("Usage: npm run provider-check -- <dhl|google-routes|orders>"); process.exit(2); }
await run();
const failed = out.filter((c) => !c.ok).length;
console.log(`\nEvidence: ${which} on ${new Date().toISOString()} — ${out.length - failed}/${out.length} checks passed. Attach this output to the launch gate.`);
process.exit(failed ? 1 : 0);
