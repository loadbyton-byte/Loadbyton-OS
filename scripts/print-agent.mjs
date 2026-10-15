#!/usr/bin/env node
// Site print agent. Runs on a PC on the warehouse network. It asks the server for queued label jobs and writes each one to the printer's raw TCP port.
//   PRINT_SERVER=https://app.example.com PRINT_TOKEN=lbtp_... node scripts/print-agent.mjs
// Optional: PRINT_POLL_SECONDS (default 5). The agent only makes outbound HTTPS requests; the server never connects in.
import net from "node:net";

export const sendToPrinter = (host, port, payload) => new Promise((resolve, reject) => {
  const s = net.connect({ host, port, timeout: 10_000 }, () => s.end(Buffer.from(payload, "utf8"), () => resolve()));
  s.on("timeout", () => { s.destroy(); reject(new Error("printer did not answer in time")); });
  s.on("error", (e) => reject(new Error(e.code === "ECONNREFUSED" ? "printer refused the connection" : e.message)));
});
/** One polling round against `server` with `token`; `fetchImpl` is injectable for tests. */
export async function tick({ server, token, fetchImpl = fetch }) {
  const call = async (path, body) => {
    const r = await fetchImpl(`${server}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20_000) });
    if (r.status === 401) throw Object.assign(new Error("The server refused this token. Create a new agent token."), { fatal: true });
    return r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`));
  };
  const { jobs } = await call("/api/print/poll");
  for (const j of jobs) {
    try { await sendToPrinter(j.host, j.port, j.payload); await call("/api/print/result", { id: j.id, ok: true }); console.log(`printed ${j.id} on ${j.host}:${j.port}`); }
    catch (e) { await call("/api/print/result", { id: j.id, ok: false, error: e.message }).catch(() => {}); console.error(`failed ${j.id}: ${e.message}`); }
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = (process.env.PRINT_SERVER || "").replace(/\/$/, ""), token = process.env.PRINT_TOKEN || "", every = Math.max(2, Number(process.env.PRINT_POLL_SECONDS || 5)) * 1000;
  if (!server || !token) { console.error("Set PRINT_SERVER and PRINT_TOKEN."); process.exit(2); }
  console.log(`print agent polling ${server} every ${every / 1000}s`);
  for (;;) {
    try { await tick({ server, token }); } catch (e) { console.error(`poll failed: ${e.message}`); if (e.fatal) process.exit(3); }
    await new Promise((r) => setTimeout(r, every));
  }
}
