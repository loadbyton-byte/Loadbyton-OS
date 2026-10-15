import { postJson, type PostResult } from "../lib/safe-http.js";

/**
 * DHL Express (MyDHL API, REST). Written from DHL's published API reference; NOT exercised against DHL's test or live service from this repository, so the first booking
 * must be made against the test environment and the label checked by hand. Domestic shipments only: cross-border parcels need customs data (invoice, line items, commodity
 * codes) that this adapter does not send, and it refuses them rather than book an incomplete declaration.
 */
export interface CarrierParty { company?: string; name: string; phone: string; email?: string; address1: string; address2?: string; city: string; country: string; postal?: string }
export interface BookRequest { reference: string; shipper: CarrierParty; receiver: CarrierParty; weightKg: number; dimensionsCm?: { length: number; width: number; height: number }; description: string; productCode: string; accountNumber: string; shipDate: Date }
export interface BookResult { trackingNo: string; label: { format: "pdf"; data: Buffer } }
export const DHL_BASE = { test: "https://express.api.dhl.com/mydhlapi/test", live: "https://express.api.dhl.com/mydhlapi" } as const;
export class CarrierError extends Error { constructor(msg: string, readonly permanent = true) { super(msg); } }

const addr = (p: CarrierParty) => ({ postalAddress: { ...(p.postal ? { postalCode: p.postal } : {}), cityName: p.city, countryCode: p.country, addressLine1: p.address1.slice(0, 45), ...(p.address2 ? { addressLine2: p.address2.slice(0, 45) } : {}) },
  contactInformation: { phone: p.phone, companyName: (p.company || p.name).slice(0, 60), fullName: p.name.slice(0, 45), ...(p.email ? { email: p.email } : {}) } });
const gmt = (d: Date) => `${new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 19)} GMT+04:00`;           // Gulf Standard Time

export function dhlShipmentBody(r: BookRequest) {
  if (r.shipper.country !== r.receiver.country) throw new CarrierError("Cross-border shipments need customs data this booking does not send. Book those in DHL's own tools.");
  return {
    plannedShippingDateAndTime: gmt(r.shipDate), pickup: { isRequested: false }, productCode: r.productCode, accounts: [{ typeCode: "shipper", number: r.accountNumber }],
    customerDetails: { shipperDetails: addr(r.shipper), receiverDetails: addr(r.receiver) },
    content: { packages: [{ weight: Math.round(r.weightKg * 1000) / 1000, ...(r.dimensionsCm ? { dimensions: r.dimensionsCm } : {}), customerReferences: [{ typeCode: "CU", value: r.reference.slice(0, 35) }] }],
      isCustomsDeclarable: false, description: r.description.slice(0, 70), unitOfMeasurement: "metric" },
    outputImageProperties: { encodingFormat: "pdf", imageOptions: [{ typeCode: "label", templateName: "ECOM26_84_001" }] },
  };
}
export async function bookDhl(account: { environment: "test" | "live"; username: string; password: string }, r: BookRequest, post: (url: string, body: string, headers: Record<string, string>) => Promise<PostResult> = (u, b, h) => postJson(u, b, h, { timeoutMs: 30_000, maxBodyBytes: 3_000_000 })): Promise<BookResult> {
  const body = JSON.stringify(dhlShipmentBody(r));
  let res: PostResult;
  try { res = await post(`${DHL_BASE[account.environment]}/shipments`, body, { authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString("base64")}`, accept: "application/json", "message-reference": r.reference.replace(/[^A-Za-z0-9]/g, "").padEnd(28, "0").slice(0, 36) }); }
  catch { throw new CarrierError("DHL could not be reached, so it is not known whether the shipment was booked. Check DHL before trying again.", false); }
  let json: any = {}; try { json = JSON.parse(res.body); } catch { /* below */ }
  if (res.status === 401 || res.status === 403) throw new CarrierError("DHL refused the account credentials.");
  if (res.status === 400 || res.status === 422) throw new CarrierError(`DHL rejected the shipment: ${String(json?.detail ?? json?.title ?? "invalid request").slice(0, 200)}${Array.isArray(json?.additionalDetails) ? ` (${json.additionalDetails.slice(0, 3).join("; ").slice(0, 200)})` : ""}`);
  if (res.status >= 500 || res.status === 429) throw new CarrierError(`DHL is unavailable (${res.status}). It is not known whether the shipment was booked. Check DHL before trying again.`, false);
  if (res.status !== 200 && res.status !== 201) throw new CarrierError(`DHL answered ${res.status}.`);
  const tracking = String(json?.shipmentTrackingNumber ?? ""), doc = (json?.documents ?? []).find((d: any) => d?.typeCode === "label");
  if (!tracking || !doc?.content) throw new CarrierError("DHL's answer had no tracking number or label. Check DHL before trying again.", false);
  const data = Buffer.from(String(doc.content), "base64");
  if (!data.length || data.subarray(0, 4).toString() !== "%PDF") throw new CarrierError("DHL's label is not a PDF. Check DHL before trying again.", false);
  return { trackingNo: tracking, label: { format: "pdf", data } };
}
