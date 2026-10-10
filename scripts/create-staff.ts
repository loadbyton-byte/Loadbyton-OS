// Usage: npm run create-staff -- <email> "<name>" <password> <commercial_admin|support|engineer|auditor>
import { openDb } from "../src/db/client.js";
import { createStaff } from "../src/platform/admin.js";
import { ensureCatalog } from "../src/platform/catalog.js";

const [email, name, password, role = "support"] = process.argv.slice(2);
if (!email || !name || !password || password.length < 12) {
  console.error('Usage: npm run create-staff -- <email> "<name>" <password (12+ chars)> <commercial_admin|support|engineer|auditor>');
  process.exit(1);
}
const db = await openDb();
await db.system((c) => ensureCatalog(c));
const r = await createStaff(db, email, name, password, role);
console.log(`Staff created: ${email} (${role})\nAdd to your authenticator app:\n  ${r.otpauth}\n  secret: ${r.totpSecret}`);
await db.close();
