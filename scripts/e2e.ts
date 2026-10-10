// End-to-end walkthrough in a real browser against a running server. Usage: BASE=http://localhost:3100 npx tsx scripts/e2e.ts
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3100";
const OUT = process.env.SHOTS ?? "/tmp/claude-0/shots";
const exe = fs.readdirSync("/opt/pw-browsers").find((d) => /^chromium-[0-9]+$/.test(d));
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? `/opt/pw-browsers/${exe}/chrome-linux/chrome` });
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
await page.fill("#or", "Shanghai"); await page.fill("#de", "Jebel Ali"); await page.fill("#cd", "CNC machinery, 2 crates"); await page.fill("#wk", "4200"); await page.fill("#rd", new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10));
await page.click("form[action='/app/enquiries'] button[type=submit]"); await shot("06-enquiry");

step("quote");
await page.click("text=Prepare quote");
await page.fill("input[name=ld]", "Ocean freight 1x40HC"); await page.fill("input[name=lp]", "9000"); await page.fill("input[name=lc]", "6500"); await page.selectOption("select[name=ls]", { label: "Maersk Agency" }); await page.selectOption("select[name=lt]", "ZR0");
await page.click("[data-add-row]"); const descs = page.locator("input[name=ld]"); await descs.nth(1).fill("Origin handling"); await page.locator("input[name=lp]").nth(1).fill("800"); await page.locator("input[name=lc]").nth(1).fill("500");
await page.click("button:has-text('Save draft')"); await shot("07-quote-draft");
await page.click("button:has-text('Submit')"); await page.click("button:has-text('Mark sent')"); await shot("08-quote-sent");
await page.click("button:has-text('Customer accepted')"); await page.waitForURL(/\/app\/jobs\//); await shot("09-job");

step("proof of delivery + milestones");
fs.writeFileSync("/tmp/claude-0/pod.pdf", "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
await page.fill("form[action*='/app/documents'] input[name=title]", "Signed POD"); await page.selectOption("form[action*='/app/documents'] select[name=kind]", "pod");
await page.setInputFiles("form[action*='/app/documents'] input[type=file]", "/tmp/claude-0/pod.pdf"); await page.click("button:has-text('Upload')");
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
await browser.close();
process.exit(errors.length ? 1 : 0);
