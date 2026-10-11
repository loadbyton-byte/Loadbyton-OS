import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.js";
import { auditBrand } from "../src/platform/brand-audit.js";
import { auditDomain } from "../src/platform/domain-audit.js";

// Usage: npm run audit:brand -- [domain]   (domain defaults to ROOT_DOMAIN)
const dir = path.resolve("public/brand");
const entries = await fs.readdir(dir, { withFileTypes: true });
const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async ({ name }) => ({ name, bytes: await fs.readFile(path.join(dir, name)) })));
const brand = auditBrand(files);
console.log("Brand files");
for (const f of brand.findings) console.log(`  ${f.level.toUpperCase().padEnd(5)} ${f.message}`);
console.log("\nAsset presence does not establish owner approval, trademark clearance or domain registrant evidence.");
const domain = process.argv[2] ?? config.rootDomain;
if (domain) {
  const d = await auditDomain(domain, { secret: config.sessionSecret, dkimSelector: process.env.MAIL_DKIM_SELECTOR });
  console.log(`\nDomain ${d.domain}`);
  for (const c of d.checks) console.log(`  ${c.level.toUpperCase().padEnd(5)} ${c.message}`);
  console.log("\nThis shows DNS state and DNS control only. Who the registrant is must be evidenced from the registrar (readiness gate: domain_ownership).");
}
