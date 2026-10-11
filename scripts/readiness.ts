import { openDb } from "../src/db/client.js";
import { readinessSummary, seedGates } from "../src/platform/readiness.js";

// Prints the release-readiness register. With --strict the exit code is 1 while any blocking gate is open.
const db = await openDb();
await seedGates(db);
const s = await readinessSummary(db);
for (const g of s.gates) console.log(`${g.effective.padEnd(19)} ${g.blocking ? "blocking" : "advisory"}  ${g.area.padEnd(14)} ${g.title}${g.owner_name ? `  [${g.owner_name}]` : ""}${g.valid_until ? `  until ${g.valid_until}` : ""}`);
console.log(`\n${s.done}/${s.total} gates accepted or waived; ${s.blockers.length} blocking open. ${s.ready ? "READY" : "NOT READY"}`);
await db.close();
if (process.argv.includes("--strict") && !s.ready) process.exitCode = 1;
