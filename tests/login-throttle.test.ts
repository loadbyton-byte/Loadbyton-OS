import { beforeAll, beforeEach, it, expect } from "vitest";
import type { Db } from "../src/db/client.js";
import { freshDb } from "./helpers.js";
import { login, resetThrottle } from "../src/platform/auth.js";

let db: Db;
beforeAll(async () => { db = await freshDb(); });
beforeEach(() => resetThrottle());

it("failed sign-ins from other addresses cannot lock a known account out", async () => {
  for (let i = 0; i < 30; i++) await expect(login(db, "victim@example.com", "wrong-password-1", `203.0.113.${i}`)).rejects.toMatchObject({ status: 401 });
  // The attacker's addresses are each below their own budget and none is throttled; the account itself is never capped.
  await expect(login(db, "victim@example.com", "wrong-password-1", "198.51.100.7")).rejects.toMatchObject({ status: 401 });
});

it("one address is throttled per email and across many emails", async () => {
  for (let i = 0; i < 8; i++) await expect(login(db, "a@example.com", "wrong-password-1", "192.0.2.1")).rejects.toMatchObject({ status: 401 });
  await expect(login(db, "a@example.com", "wrong-password-1", "192.0.2.1")).rejects.toMatchObject({ status: 429 });
  resetThrottle();
  for (let i = 0; i < 40; i++) await expect(login(db, `u${i}@example.com`, "wrong-password-1", "192.0.2.2")).rejects.toMatchObject({ status: 401 });
  await expect(login(db, "u99@example.com", "wrong-password-1", "192.0.2.2")).rejects.toMatchObject({ status: 429 });
});
