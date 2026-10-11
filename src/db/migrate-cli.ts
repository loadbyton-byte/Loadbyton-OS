import { openDb } from "./client.js";
const db = await openDb({url:process.env.MIGRATION_DATABASE_URL||undefined,migrate:true});
console.log("migrations applied");
await db.close();
