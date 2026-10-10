// Run against a restored database to prove it reconciles. Usage: DATABASE_URL=<restored db> npm run verify
import { openDb } from "../src/db/client.js";
import { verifyInvariants } from "../src/platform/invariants.js";
const db = await openDb();
const v = await verifyInvariants(db);
if (v.length) { console.error(`${v.length} invariant violation(s):`); for (const x of v) console.error(` - ${x.check}: ${x.detail}`); process.exitCode = 1; }
else console.log("All invariants hold.");
await db.close();
