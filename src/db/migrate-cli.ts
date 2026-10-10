import { openDb } from "./client.js";
const db = await openDb();
console.log("migrations applied");
await db.close();
