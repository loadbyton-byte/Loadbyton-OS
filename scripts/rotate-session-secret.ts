import { openDb } from "../src/db/client.js";
import { resealSessionSecrets } from "../src/platform/secret-rotation.js";
// Dry run by default. Secrets, plaintext and row identifiers are never logged.
const args = process.argv.slice(2), apply = args.includes("--apply");
let db;
try {
  if (args.some((a) => a !== "--apply")) throw new Error("Use no arguments for a dry run or --apply");
  if (!process.env.SESSION_SECRET || !process.env.SESSION_SECRET_PREVIOUS) throw new Error("Set SESSION_SECRET and SESSION_SECRET_PREVIOUS");
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("A direct privileged database URL is required");
  db = await openDb({ url, migrate: false });
  console.log(JSON.stringify(await resealSessionSecrets(db, process.env.SESSION_SECRET, process.env.SESSION_SECRET_PREVIOUS, apply)));
} catch { console.error("Session secret rotation failed; nothing was committed. Check configuration and sealed-value integrity using the runbook."); process.exitCode = 1; } finally { await db?.close(); }
