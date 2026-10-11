import { beforeAll, afterEach, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant } from "./helpers.js";
import { config } from "../src/config.js";
import { seal, unseal } from "../src/lib/seal.js";
import { createParty } from "../src/ops/crm.js";
import { resealSessionSecrets } from "../src/platform/secret-rotation.js";
import { encryptBackup, decryptBackup, reencryptBackup } from "../src/platform/backup.js";
import { signDownload, verifyDownload } from "../src/ops/documents.js";
import { stripeAdapter, signStripePayload } from "../src/platform/payments/stripe.js";

let db: Db;
const original = config.sessionSecret, originalPrev = config.previousSessionSecret;
const OLD = "fixture-previous-session-secret-32chars!", NEW = "fixture-current-session-secret-32chars!!";
beforeAll(async () => { db = await freshDb(); });
afterEach(() => { config.sessionSecret = original; config.previousSessionSecret = originalPrev; });

it("session-secret rotation: dual-key unseal and signed links, then atomic re-seal that is safe to repeat", async () => {
  config.sessionSecret = OLD; config.previousSessionSecret = "";
  const link = signDownload("t", "d", 300), legacy = seal("merchant-webhook-secret");
  config.sessionSecret = NEW; config.previousSessionSecret = OLD;
  expect(verifyDownload("t", "d", link.exp, link.sig)).toBe(true);
  expect(unseal(legacy)).toBe("merchant-webhook-secret");
  config.previousSessionSecret = "";
  expect(verifyDownload("t", "d", link.exp, link.sig)).toBe(false);
  expect(() => unseal(legacy)).toThrow();
  config.previousSessionSecret = OLD;

  const t = await newTenant(db, undefined, ["delivery"]);
  const party = await db.tenant(t.tenantId, (c) => createParty(c, t.ctx, { kind: "customer", name: "Rotating merchant" }));
  await db.query(`INSERT INTO dlv_merchant_settings(tenant_id,merchant_id,webhook_url,webhook_secret_sealed,webhook_active) VALUES($1,$2,'https://example.com/h',$3,true)`, [t.tenantId, party, legacy]);
  const dry = await resealSessionSecrets(db, NEW, OLD);
  expect(dry.counts.dlv_merchant_settings.pending).toBeGreaterThanOrEqual(1);
  expect((await db.query<any>(`SELECT webhook_secret_sealed s FROM dlv_merchant_settings WHERE merchant_id=$1`, [party])).rows[0].s).toBe(legacy);
  await resealSessionSecrets(db, NEW, OLD, true);
  const after = (await db.query<any>(`SELECT webhook_secret_sealed s FROM dlv_merchant_settings WHERE merchant_id=$1`, [party])).rows[0].s;
  config.previousSessionSecret = "";
  expect(unseal(after)).toBe("merchant-webhook-secret");
  expect((await resealSessionSecrets(db, NEW, OLD, true)).counts.dlv_merchant_settings.rotated).toBe(0);
  await db.query(`UPDATE dlv_merchant_settings SET webhook_secret_sealed='garbage.a.b.c' WHERE merchant_id=$1`, [party]);
  await expect(resealSessionSecrets(db, NEW, OLD, true)).rejects.toThrow(/neither secret/);
});

it("backup keys rotate by verified re-encryption and the output is discarded on any failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lbt-bk-"));
  const plain = path.join(dir, "p.sql"), enc = path.join(dir, "old.enc"), out = path.join(dir, "new.enc"), back = path.join(dir, "back.sql");
  const A = "backup-key-A-0123456789-0123456789!!", B = "backup-key-B-0123456789-0123456789!!";
  await fs.writeFile(plain, "select 1; -- backup body");
  await encryptBackup(plain, enc, A);
  await reencryptBackup(enc, out, A, B);
  await decryptBackup(out, back, B);
  expect(await fs.readFile(back, "utf8")).toBe("select 1; -- backup body");
  await expect(decryptBackup(out, path.join(dir, "x.sql"), A)).rejects.toThrow(/authentication/);
  await expect(reencryptBackup(enc, path.join(dir, "bad.enc"), B, A)).rejects.toThrow();
  await expect(fs.stat(path.join(dir, "bad.enc"))).rejects.toThrow();
  await expect(reencryptBackup(enc, path.join(dir, "same.enc"), A, A)).rejects.toThrow(/differ/);
  await fs.rm(dir, { recursive: true });
});

it("a webhook signed with the previous Stripe signing secret is accepted during the rotation window only", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", metadata: {}, payment_status: "paid" } } });
  const sign = (s: string) => signStripePayload(body, s);
  const mk = (prev?: string) => stripeAdapter({ secretKey: "sk_test_x", webhookSecret: "whsec_new", webhookSecretPrevious: prev, apiBase: "http://x", paymentMethods: [] } as any);
  const hdr = (h: string) => (n: string) => (n === "stripe-signature" ? h : undefined);
  expect(() => mk("whsec_old").parseWebhook(body, hdr(sign("whsec_old")))).not.toThrow();
  expect(() => mk().parseWebhook(body, hdr(sign("whsec_old")))).toThrow(/signature/);
});
