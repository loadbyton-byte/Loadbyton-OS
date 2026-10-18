import type { Db } from "../db/client.js";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest } from "../lib/util.js";
import { FEATURES, applyFeatureSettings, featureByCode, type PaidPlan } from "./features.js";

/** Staff overrides of the built-in add-on catalogue. Cached briefly per database so every page does not query it. */
const cache = new WeakMap<Db, number>();
const TTL_MS = 15_000;
const STAFF = ["commercial_admin", "support", "engineer"];

export async function ensureFeatureSettings(db: Db, force = false) {
  const at = cache.get(db) ?? 0;
  if (!force && Date.now() - at < TTL_MS) return;
  const rows = (await db.query<{ code: string; enabled: boolean; min_plan: PaidPlan | null }>(`SELECT code, enabled, min_plan FROM feature_settings`)).rows;
  applyFeatureSettings(rows);
  cache.set(db, Date.now());
}

export async function saveFeatureSetting(db: Db, staff: { userId: string; role: string | null }, code: string, input: { enabled: boolean; minPlan: string }) {
  if (!staff.role || !STAFF.includes(staff.role)) throw new HttpError(403, `This action needs one of: ${STAFF.join(", ")}.`, "forbidden");
  const f = featureByCode(code);
  if (!f) throw new HttpError(404, "Feature not found", "not_found");
  if (f.tier === "free" && input.minPlan) throw badRequest("A free feature has no plan.");
  const minPlan = f.tier === "paid" ? (["starter", "business", "operations"].includes(input.minPlan) ? input.minPlan : null) : null;
  if (f.tier === "paid" && !minPlan) throw badRequest("Choose the monthly plan this add-on needs.");
  await db.system(async (c) => {
    await c.query(
      `INSERT INTO feature_settings(code,enabled,min_plan,updated_by,updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (code) DO UPDATE SET enabled=$2,min_plan=$3,updated_by=$4,updated_at=now()`, [code, input.enabled, minPlan, staff.userId]);
    await audit(c, null, { kind: "platform_staff", userId: staff.userId }, "feature.setting", "feature", code, { enabled: input.enabled, minPlan });
  });
  await ensureFeatureSettings(db, true);
}

export const catalogueRows = () => FEATURES;
