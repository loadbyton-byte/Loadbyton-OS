import path from "node:path";
import { reencryptBackup } from "../src/platform/backup.js";
// Usage: BACKUP_ENCRYPTION_KEY=<new> BACKUP_ENCRYPTION_PREVIOUS_KEY=<old> tsx scripts/rotate-backup-key.ts <backup.enc> <output.enc>
try {
  const [input, output] = process.argv.slice(2);
  const next = process.env.BACKUP_ENCRYPTION_KEY ?? "", prev = process.env.BACKUP_ENCRYPTION_PREVIOUS_KEY ?? "";
  if (!input || !output || path.resolve(input) === path.resolve(output)) throw new Error("Give distinct input and output paths");
  if (next.length < 32 || prev.length < 32) throw new Error("Both keys need 32+ characters");
  console.log(JSON.stringify({ rotated: true, ...(await reencryptBackup(input, output, prev, next)) }));
} catch { console.error("Backup key rotation failed; no output file was kept."); process.exitCode = 1; }
