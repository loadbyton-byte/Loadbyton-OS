import crypto from "node:crypto";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { config } from "../src/config.js";
import { freshDb, newTenant } from "./helpers.js";
import { clientAssertion, detachedJws, httpSignature, verifyBytes, verifyDetachedJws, checkKeyForAlg, signBytes } from "../src/lib/message-signing.js";
import { createFeedConnection, pullFeed } from "../src/ops/live-feeds.js";
import { resealSessionSecrets } from "../src/platform/secret-rotation.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtls-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const sh = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

// a private CA, a server certificate for bank.example.test and a client certificate
sh("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Test Bank CA", "-days", "30");
sh("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=bank.example.test");
fs.writeFileSync(path.join(dir, "san.cnf"), "subjectAltName=DNS:bank.example.test\n");
sh("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "30", "-extfile", "san.cnf");
sh("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=Our TPP");
sh("x509", "-req", "-in", "client.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.pem", "-days", "30");
sh("genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", "sign.key");
sh("req", "-new", "-x509", "-key", "sign.key", "-out", "sign.pem", "-subj", "/CN=Signing", "-days", "30");
sh("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ec.pem");
sh("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "other.key", "-out", "other.pem", "-x509", "-subj", "/CN=Other", "-days", "30");

describe("message signing primitives", () => {
  it("detached JWS verifies, is bound to the body, and supports RSA-PSS, RSA and ECDSA keys", () => {
    for (const [alg, key] of [["PS256", read("sign.key")], ["RS256", read("sign.key")], ["ES256", read("ec.pem")]] as const) {
      const pub = alg === "ES256" ? crypto.createPublicKey(read("ec.pem")).export({ type: "spki", format: "pem" }).toString() : read("sign.pem");
      const jws = detachedJws('{"a":1}', { alg, kid: "kid-1", key, extra: { iat: 1 }, crit: ["iat"] });
      expect(jws.split(".")[1]).toBe("");                                                      // detached: the payload part is empty
      expect(verifyDetachedJws(jws, '{"a":1}', pub)).toBe(true);
      expect(verifyDetachedJws(jws, '{"a":2}', pub)).toBe(false);
      const header = JSON.parse(Buffer.from(jws.split(".")[0], "base64url").toString());
      expect(header).toMatchObject({ alg, kid: "kid-1", b64: false, crit: ["b64", "iat"] });
    }
  });
  it("HTTP Signature carries a body digest and a signature over the request target, host, date and digest", () => {
    const h = httpSignature({ method: "POST", url: "https://bank.example.test/v1/consents?x=1", body: '{"b":2}', keyId: "key-7", key: read("sign.key"), alg: "RS256", now: new Date("2026-10-20T10:00:00Z") });
    expect(h.digest).toBe(`SHA-256=${crypto.createHash("sha256").update('{"b":2}').digest("base64")}`);
    const m = /keyId="key-7",algorithm="rsa-sha256",headers="([^"]+)",signature="([^"]+)"/.exec(h.signature)!;
    expect(m[1]).toBe("(request-target) host date digest");
    const base = `(request-target): post /v1/consents?x=1\nhost: bank.example.test\ndate: Tue, 20 Oct 2026 10:00:00 GMT\ndigest: ${h.digest}`;
    expect(verifyBytes("RS256", read("sign.pem"), base, Buffer.from(m[2], "base64"))).toBe(true);
    expect(verifyBytes("RS256", read("sign.pem"), base + "x", Buffer.from(m[2], "base64"))).toBe(false);
  });
  it("client assertion carries iss, sub, aud, jti and a short expiry, and keys are checked against the algorithm", () => {
    const jwt = clientAssertion({ clientId: "client-1", audience: "https://bank.example.test/token", alg: "PS256", kid: "k1", key: read("sign.key"), now: 1_800_000_000_000 });
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({ iss: "client-1", sub: "client-1", aud: "https://bank.example.test/token", iat: 1_800_000_000, exp: 1_800_000_120 });
    expect(verifyBytes("PS256", read("sign.pem"), `${h}.${p}`, Buffer.from(s, "base64url"))).toBe(true);
    expect(() => checkKeyForAlg("ES256", read("sign.key"))).toThrow(/EC P-256/); expect(() => checkKeyForAlg("PS256", read("ec.pem"))).toThrow(/RSA/); expect(() => checkKeyForAlg("PS256", "nope")).toThrow(/valid PEM/);
    expect(signBytes("ES256", read("ec.pem"), "x").length).toBe(64);                           // IEEE P1363 r||s
  });
});

describe("a bank feed over mutual TLS with signed requests", () => {
  const PORT = 8443;
  it("presents the client certificate, pins the bank's CA, signs each request and rejects a missing or wrong certificate", async () => {
    const seen: { cn?: string; sig?: string; digest?: string; auth?: string }[] = [];
    const server = https.createServer({ key: read("server.key"), cert: read("server.pem"), ca: read("ca.pem"), requestCert: true }, (req, res) => {
      const peer = (req.socket as any).getPeerCertificate?.();
      if (!(req.socket as any).authorized) { res.writeHead(401).end(); return; }
      seen.push({ cn: peer?.subject?.CN, sig: String(req.headers["x-jws-signature"] ?? ""), auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: "M1", date: "2026-10-01", amount: "10.00", description: "x" }]));
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    const saved = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["bank.example.test"];
    const lookup = ((_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as any;
    const po = { allowPrivate: true, lookup };
    try {
      const t = await newTenant(db);
      const base = { kind: "bank", label: "MTLS bank", url: `https://bank.example.test:${PORT}/v1/tx`, secret: "tok", tls_ca: read("ca.pem"), tls_cert: read("client.pem"), tls_key: read("client.key"), sign_mode: "jws", sign_alg: "PS256", sign_kid: "kid-9", sign_key: read("sign.key") };
      const id = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, base));
      const r = await pullFeed(db, t.tenantId, id, { postOptions: po });
      expect(r).toMatchObject({ added: 1 });
      expect(seen[0].cn).toBe("Our TPP"); expect(seen[0].auth).toBe("Bearer tok");
      expect(verifyDetachedJws(seen[0].sig!, "", read("sign.pem"))).toBe(true);                    // the bank can verify our signature with our certificate
      // stored sealed
      const row = (await db.query<any>(`SELECT tls_key_sealed, sign_key_sealed FROM feed_connections WHERE id=$1`, [id])).rows[0];
      expect(row.tls_key_sealed).not.toContain("PRIVATE KEY"); expect(row.sign_key_sealed).not.toContain("PRIVATE KEY");
      // the same feed without a client certificate is refused by the bank
      await db.query(`UPDATE feed_connections SET tls_cert_sealed=NULL, tls_key_sealed=NULL WHERE id=$1`, [id]);
      const noCert = await pullFeed(db, t.tenantId, id, { postOptions: po });
      expect(noCert.error).toBeTruthy();
      // a bank certificate from some other CA is not trusted when a CA is pinned
      const id2 = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { ...base, label: "Wrong CA", tls_ca: read("other.pem") }));
      expect((await pullFeed(db, t.tenantId, id2, { postOptions: po })).error).toBeTruthy();
      // re-sealing under a new session secret keeps the keys readable
      const oldSecret = "old-secret-old-secret-old-secret-0000";
      await db.query(`UPDATE feed_connections SET sign_key_sealed=$2 WHERE id=$1`, [id2, (await import("../src/lib/seal.js")).seal(read("sign.key"), oldSecret)]);
      expect((await resealSessionSecrets(db, config.sessionSecret, oldSecret, true)).counts["feed_connections.sign_key_sealed"].rotated).toBeGreaterThanOrEqual(1);
    } finally { config.liveFeeds.allowedHosts = saved; server.close(); }
  });

  it("validates certificates, keys and algorithms when a feed is saved", async () => {
    const saved = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["bank.example.test"];
    try {
      const t = await newTenant(db);
      const mk = (over: Record<string, any>) => db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { kind: "bank", label: `f${Math.random()}`, url: "https://bank.example.test/tx", secret: "tok", ...over }));
      await expect(mk({ tls_cert: read("client.pem") })).rejects.toThrow(/both the client certificate and its private key/);
      await expect(mk({ tls_cert: "junk", tls_key: read("client.key") })).rejects.toThrow(/valid PEM certificate/);
      await expect(mk({ tls_cert: read("client.pem"), tls_key: read("sign.key") })).rejects.toThrow(/does not belong/);
      await expect(mk({ tls_ca: "junk" })).rejects.toThrow(/pinned server CA/);
      await expect(mk({ sign_mode: "jws", sign_alg: "ES256", sign_kid: "k", sign_key: read("sign.key") })).rejects.toThrow(/EC P-256/);
      await expect(mk({ sign_mode: "jws", sign_alg: "PS256", sign_kid: "bad kid!", sign_key: read("sign.key") })).rejects.toThrow(/key identifier/);
      await expect(mk({ sign_mode: "jws", sign_alg: "PS256", sign_kid: "k" })).rejects.toThrow(/signing private key/);
      await expect(mk({ auth_scheme: "oauth2_client", token_url: "https://bank.example.test/t", secret: "id:secret", client_auth: "private_key_jwt", sign_alg: "PS256", sign_kid: "k", sign_key: read("sign.key") })).rejects.toThrow(/client_id only/);
      await expect(mk({ auth_scheme: "oauth2_client", token_url: "https://bank.example.test/t", secret: "client-1", client_auth: "private_key_jwt", sign_alg: "PS256", sign_kid: "k", sign_key: read("sign.key") })).resolves.toBeTruthy();
    } finally { config.liveFeeds.allowedHosts = saved; }
  });

  it("signs the OAuth token request with private_key_jwt instead of a shared secret", async () => {
    const saved = config.liveFeeds.allowedHosts; config.liveFeeds.allowedHosts = ["bank.example.test"];
    try {
      const t = await newTenant(db);
      const id = await db.tenant(t.tenantId, (c) => createFeedConnection(c, t.ctx, { kind: "bank", label: "pkjwt", url: "https://bank.example.test/tx", auth_scheme: "oauth2_client", token_url: "https://bank.example.test/token", secret: "client-1", client_auth: "private_key_jwt", sign_alg: "PS256", sign_kid: "kid-3", sign_key: read("sign.key") }));
      let form: Record<string, string> = {}, headers: Record<string, string> = {};
      await pullFeed(db, t.tenantId, id, {
        post: async (_u: string, body: string, h: Record<string, string>) => { form = Object.fromEntries(new URLSearchParams(body)); headers = h; return { status: 200, body: JSON.stringify({ access_token: "AT" }) }; },
        get: async () => ({ status: 200, body: "[]" }),
      });
      expect(form).toMatchObject({ grant_type: "client_credentials", client_id: "client-1", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" });
      expect(headers.authorization).toBeUndefined();
      const [h, p, s] = form.client_assertion.split(".");
      expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({ iss: "client-1", aud: "https://bank.example.test/token" });
      expect(verifyBytes("PS256", read("sign.pem"), `${h}.${p}`, Buffer.from(s, "base64url"))).toBe(true);
    } finally { config.liveFeeds.allowedHosts = saved; }
  });
});
