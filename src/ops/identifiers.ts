import { iso6346Valid } from "./doc-extract.js";
import { validateAwb } from "./freight-commercial.js";

/**
 * Advisory identifier checks for specialist cases. They tell the operator when a container number, air waybill, IMO number or North American
 * VIN fails its published check digit — a likely typing error. They never block a case: references from some sources legitimately differ,
 * and the qualified person decides.
 */
export interface IdCheck { label: string; value: string; valid: boolean; rule: string }

/** IMO ship identification: seven digits whose first six, weighted 7 to 2, sum to a number whose last digit is the seventh. */
export function imoValid(n: string): boolean {
  if (!/^\d{7}$/.test(n)) return false;
  let s = 0; for (let i = 0; i < 6; i++) s += Number(n[i]) * (7 - i);
  return s % 10 === Number(n[6]);
}
const VIN_MAP: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
/** The ninth-character check digit is mandatory for vehicles built for North America (WMI starting 1–5); elsewhere it is not defined. */
export function vinCheckApplies(vin: string) { return /^[1-5]/.test(vin); }
export function vinCheckValid(vin: string): boolean {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0; for (let i = 0; i < 17; i++) sum += (/\d/.test(vin[i]) ? Number(vin[i]) : VIN_MAP[vin[i]]) * VIN_W[i];
  const r = sum % 11;
  return vin[8] === (r === 10 ? "X" : String(r));
}

export function identifierChecks(sector: string, a: Record<string, any>): IdCheck[] {
  const out: IdCheck[] = [];
  const container = (v: unknown) => { const s = String(v ?? "").toUpperCase().replace(/\s/g, ""); if (s) out.push({ label: "Container number", value: s, valid: iso6346Valid(s), rule: "ISO 6346 check digit" }); };
  if (sector === "container-depot" || sector === "consolidation-nvocc") container(a.container_ref);
  if (sector === "aviation-logistics") { const v = String(a.airwaybill ?? "").trim(); if (/^\d{3}[- ]?\d{8}$/.test(v)) { let ok = true; try { validateAwb(v); } catch { ok = false; } out.push({ label: "Air waybill", value: v, valid: ok, rule: "IATA check digit (serial mod 7)" }); } }
  if (sector === "marine-agency") { const m = /(?:IMO[\s:-]*)?(\d{7})\b/i.exec(String(a.vessel_ref ?? "")); if (m) out.push({ label: "IMO number", value: m[1], valid: imoValid(m[1]), rule: "IMO check digit" }); }
  if (sector === "automotive-logistics") { const v = String(a.vin ?? "").toUpperCase(); if (v.length === 17 && vinCheckApplies(v)) out.push({ label: "VIN", value: v, valid: vinCheckValid(v), rule: "North American check digit (position 9)" }); }
  return out;
}
