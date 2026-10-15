import net from "node:net";
import { describe, it, expect, beforeAll } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb, newTenant } from "./helpers.js";
import { RfSession, rfLogin, setRfPin } from "../src/ops/rf-terminal.js";
import { startRfServer, stripTelnet } from "../src/rf-server.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
async function co() {
  const t = await newTenant(db, undefined, ["contract-warehouse"]);
  const slug = (await db.system((c) => c.query<any>(`SELECT slug FROM tenants WHERE id=$1`, [t.tenantId]))).rows[0].slug as string;
  const email = (await db.system((c) => c.query<any>(`SELECT email FROM users WHERE id=$1`, [t.ctx.userId]))).rows[0].email as string;
  return { t, slug, email };
}

describe("RF terminal", () => {
  it("validates PINs, signs in with the right one, and locks after repeated wrong ones", async () => {
    const { t, slug, email } = await co();
    await expect(db.tenant(t.tenantId, (c) => setRfPin(c, t.ctx, t.ctx.userId, "123456"))).rejects.toThrow(/sequential/);
    await expect(db.tenant(t.tenantId, (c) => setRfPin(c, t.ctx, t.ctx.userId, "12ab"))).rejects.toThrow(/digits/);
    await db.tenant(t.tenantId, (c) => setRfPin(c, t.ctx, t.ctx.userId, "483920"));
    const raw = (await db.system((c) => c.query<any>(`SELECT pin_hash FROM rf_pins`))).rows[0].pin_hash;
    expect(raw).not.toContain("483920");
    expect((await rfLogin(db, slug, email, "483920")).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(await rfLogin(db, slug, email, "000111")).toMatchObject({ ok: false });
    expect(await rfLogin(db, slug, email, "483920")).toMatchObject({ ok: false, reason: expect.stringMatching(/Locked/) });
    expect(await rfLogin(db, "nope", email, "483920")).toMatchObject({ ok: false, reason: "Sign-in failed." });
  });

  it("walks sign-in, look-up and quit as a conversation, with no hint about which part was wrong", async () => {
    const { t, slug, email } = await co();
    await db.tenant(t.tenantId, (c) => setRfPin(c, t.ctx, t.ctx.userId, "593817"));
    const s = new RfSession(db, 20);
    expect(s.banner().join("|")).toMatch(/Company/);
    await s.feed(slug); await s.feed(email);
    expect((await s.feed("593817")).join("|")).toMatch(/Signed in/);
    expect((await s.feed("1")).join("|")).toMatch(/Scan/);
    expect((await s.feed("NOPE-CODE")).join("|")).toMatch(/Not found/);
    await s.feed("0"); expect(s.closed).toBe(true);
    const f = new RfSession(db); await f.feed(slug); await f.feed(email);
    expect((await f.feed("999999")).join("|")).toBe("Sign-in failed."); expect(f.closed).toBe(true);
  });

  it("serves the protocol over a real socket and ignores Telnet negotiation bytes", async () => {
    const { t, slug, email } = await co();
    await db.tenant(t.tenantId, (c) => setRfPin(c, t.ctx, t.ctx.userId, "274619"));
    const server = startRfServer(db, 0, "127.0.0.1", 40); await new Promise((r) => server.once("listening", r));
    const port = (server.address() as net.AddressInfo).port;
    const sock = net.connect(port, "127.0.0.1"); let got = "";
    sock.on("data", (d) => { got += d.toString(); });
    const until = async (re: RegExp) => { for (let i = 0; i < 200 && !re.test(got); i++) await new Promise((r) => setTimeout(r, 25)); expect(got).toMatch(re); };
    await until(/Company/);
    sock.write(Buffer.from([255, 251, 1])); sock.write(`${slug}\r\n`); await until(/e-mail/);
    sock.write(`${email}\r\n`); await until(/PIN/); sock.write("274619\r\n"); await until(/Signed in/);
    sock.write("0\r\n"); await until(/Bye/); sock.destroy(); server.close();
    expect(stripTelnet(Buffer.from([255, 251, 1, 65, 66]))).toBe("AB");
  });
});
