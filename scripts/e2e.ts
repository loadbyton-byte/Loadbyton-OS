// End-to-end walkthrough in a real browser against a running server. Usage: BASE=http://localhost:3000 npx tsx scripts/e2e.ts
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.SHOTS ?? "/tmp/loadbyton-e2e/shots";
fs.mkdirSync(OUT, { recursive: true });
const exe = !process.env.CHROME && fs.existsSync("/opt/pw-browsers")
  ? fs.readdirSync("/opt/pw-browsers").find((d) => /^chromium-[0-9]+$/.test(d)) : undefined;
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? (exe ? `/opt/pw-browsers/${exe}/chrome-linux/chrome` : undefined),
  args: process.env.CHROME_NO_SANDBOX === "true" ? ["--no-sandbox"] : [],
});
try {
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
page.on("response", (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const shot = (n: string) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const go = async (p: string) => { await page.goto(BASE + p); };
const step = (s: string) => console.log("•", s);
const email = `e2e${Date.now()}@example.com`;

await go("/"); await shot("01-home");
await go("/pricing"); await shot("02-pricing");
await go("/find-my-bundle?sector=freight-forwarding&sector=customs-brokerage"); await shot("03-bundle");

step("register");
await go("/start");
await page.fill("#company", "Gulf Gate Freight LLC"); await page.fill("#contact", "Amira Hassan"); await page.fill("#email", email); await page.fill("#pw", "correct horse battery");
await page.click("button[type=submit]");
await page.waitForURL(/\/app/); await shot("04-overview");

step("customer + supplier");
await go("/app/parties");
await page.fill("#pn", "Desert Trading FZE"); await page.selectOption("#pk", "customer"); await page.fill("#pc", "50000"); await page.click("form[action='/app/parties'] button[type=submit]");
await page.fill("#pn", "Maersk Agency"); await page.selectOption("#pk", "supplier"); await page.click("form[action='/app/parties'] button[type=submit]");
await shot("05-parties");

step("enquiry");
await go("/app/enquiries/new");
await page.selectOption("#pa", { label: "Desert Trading FZE" }); await page.selectOption("#mo", "ocean");
await page.fill("#or", "Shanghai"); await page.fill("#de", "Jebel Ali"); await page.fill("#cd", "CNC machinery, 2 crates"); await page.fill("#wk", "4200"); await page.fill("#vc", "6"); await page.fill("#rd", new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10));
await page.click("form[action='/app/enquiries'] button[type=submit]"); await shot("06-enquiry");

step("reviewed provider chargeable weight");
const enquiryPath = new URL(page.url()).pathname;
const tariffPath = path.join(OUT, "provider-tariff-fixture.pdf");
fs.writeFileSync(tariffPath, "%PDF-1.4\nVerification fixture provider tariff\n%%EOF");
await go('/app/documents');await page.fill('form[action="/app/documents"] [name=title]','Verification provider tariff');await page.fill('#external-issuer','Verification provider');await page.setInputFiles('form[action="/app/documents"] [name=file]',tariffPath);await page.click('form[action="/app/documents"] button');
await go('/app/freight/weight');await page.fill('#provider','Verification ocean LCL');await page.selectOption('#weight-mode','ocean');await page.selectOption('#weight-formula','weight_measure');await page.fill('#coefficient','1000');await page.fill('#increment','0.1');await page.fill('#minimum','1');await page.fill('#valid_from',new Date().toISOString().slice(0,10));await page.fill('#valid_until',new Date(Date.now()+30*864e5).toISOString().slice(0,10));await page.fill('#reviewer','Verification tariff reviewer');await page.fill('#weight-scope','Fixture general cargo LCL Shanghai to Jebel Ali');await page.click('form[action="/app/freight/weight/rules"] button');
await page.selectOption('#weight-enquiry',enquiryPath.split('/').pop()!);await page.check('[name=scope_confirmed]');await page.click('form[action="/app/freight/weight/assess"] button');
if(!/6 revenue tonnes/.test(await page.locator('body').innerText()))throw new Error('Provider weight calculation not visible');
await shot('06b-chargeable-weight');await go(enquiryPath);

step("quote");
await page.click("text=Prepare quote");
await page.fill("input[name=ld]", "Ocean freight 1x40HC"); await page.fill("input[name=lp]", "9000"); await page.fill("input[name=lc]", "6500"); await page.selectOption("select[name=ls]", { label: "Maersk Agency" }); await page.selectOption("select[name=lt]", "ZR0");
await page.click("[data-add-row]"); const descs = page.locator("input[name=ld]"); await descs.nth(1).fill("Origin handling"); await page.locator("input[name=lp]").nth(1).fill("800"); await page.locator("input[name=lc]").nth(1).fill("500");
await page.click("button:has-text('Save draft')"); await shot("07-quote-draft");
await page.click("button:has-text('Submit')"); await page.click("button:has-text('Mark sent')"); await shot("08-quote-sent");
await page.click("button:has-text('Customer accepted')"); await page.waitForURL(/\/app\/jobs\//); await shot("09-job");

step("source-linked assistant draft");
const assistantJobPath=new URL(page.url()).pathname;await go('/app/assistant');
const assistantForm=page.locator('form').filter({has:page.locator('input[name="resource"][value="job"]')});
await assistantForm.locator('select[name="source_id"]').selectOption(assistantJobPath.split('/').pop()!);
await assistantForm.locator('select[name="purpose"]').selectOption('summary');await assistantForm.locator('button').click();await page.waitForURL(/\/app\/assistant\/[^/?]+/);
if(!/human review required/i.test(await page.locator('body').innerText()))throw new Error('Assistant review boundary missing');
if(!(await page.locator('body').innerText()).includes('Completed milestones: 0/6'))throw new Error('Assistant job snapshot is inaccurate');
await shot('09a-assistant-draft');await go(assistantJobPath);

step("proof of delivery + milestones");
const podPath = path.join(OUT, "pod.pdf");
fs.writeFileSync(podPath, "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
await page.fill("form[action*='/app/documents'] input[name=title]", "Signed POD"); await page.selectOption("form[action*='/app/documents'] select[name=kind]", "pod");await page.fill("form[action*='/app/documents'] input[name=issuer]","Verification customer signatory");
await page.setInputFiles("form[action*='/app/documents'] input[type=file]", podPath); await page.click("button:has-text('Upload')");

step('versioned source-linked packing list draft');
const draftJobPath=new URL(page.url()).pathname;await go('/app/document-drafts');await page.selectOption('#template-kind','packing_list');await page.fill('#template-title','Reviewed verification packing list');await page.fill('#template-footer','Verification fixture only; customer particulars require review');await page.click('form[action="/app/document-drafts/templates"] button');await page.getByRole('link',{name:'Prepare draft'}).first().click();await page.selectOption('#draft-job',draftJobPath.split('/').pop()!);
await page.fill('#draft-shipper','Verification shipper');await page.fill('#draft-consignee','Verification consignee');await page.fill('#draft-contents','CNC machinery, 2 crates');await page.fill('#draft-packages','2');await page.fill('#draft-gross_kg','4200');await page.fill('#draft-net_kg','4100');await page.fill('#draft-volume_cbm','6');await page.fill('#draft-marks','Fixture shipping marks');await page.click('form[action="/app/document-drafts"] button');await page.waitForURL(/\/app\/document-drafts\/[0-9a-f-]{36}(\?|$)/);if(!(await page.locator('.print-doc').innerText()).includes('GENERATED DRAFT'))throw new Error('Generated draft review boundary missing');await shot('09b-packing-draft');const printable=await page.pdf({path:path.join(OUT,'packing-list-draft.pdf'),format:'A4',printBackground:true});if(printable.length<1000)throw new Error('Printable draft PDF is empty');await go(draftJobPath);

for (let i = 0; i < 6; i++) { await page.locator("button:has-text('Record now')").first().click(); }
await page.click("button:has-text('Mark operationally complete')"); await shot("10-job-delivered");

step("invoice + receipt");
await page.click("button:has-text('Invoice approved charges')"); await shot("11-invoice");
await page.locator("input[name=amount]").fill("2000"); await page.click("button:has-text('Record receipt')");
await go("/app/reports"); await shot("12-dashboard");
await go("/app/billing"); await shot("13-billing");
await go("/app/team"); await shot("14-team");

step("upgrade via simulated checkout");
await go("/app/settings"); await page.fill("#ln", "Gulf Gate Freight LLC"); await page.click("form[action='/app/settings/entity'] button");
await go("/app/billing"); await page.locator("form[action='/app/billing/checkout'] button").first().click(); await shot("15-checkout");
await page.click("button:has-text('Simulate successful payment')"); await shot("16-after-payment");
await go("/app/billing"); await shot("17-billing-after");

console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no browser errors");
process.exitCode = errors.length ? 1 : 0;
} finally { await browser.close(); }
