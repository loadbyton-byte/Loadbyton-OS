# Merchant API v1 (courier / last mile)

Server-to-server. A key belongs to **one merchant of one courier company** and can only see and create that merchant's parcels. Keys are created by the courier's owner under *Delivery → Integrations* and shown once.

```
Authorization: Bearer lbtk_…
Content-Type: application/json
```
Errors are JSON: `{ "error": { "code": "…", "message": "…" } }` — `401 unauthorized`, `400 invalid_request|invalid_json`, `402 restricted` (workspace read-only), `403 forbidden`, `404 not_found`, `429 rate_limited` (120 requests/minute per key). Responses are never cached.

## Create a parcel — `POST /api/v1/parcels`
Idempotent on `reference`: repeating a request returns the same parcel (`200`, `"created": false`) instead of a second one. First time: `201`.

| Field | Type | Notes |
|---|---|---|
| `reference` | string ≤ 80 | your order id (required) |
| `consignee_name`, `address`, `emirate` | string | required; emirate is one of Abu Dhabi, Dubai, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah, Fujairah |
| `consignee_phone` | string | UAE mobile numbers can receive SMS if the courier enabled it for you |
| `cod` | number or "12.50" | AED to collect in cash, 0–50,000 (omit for prepaid) |
| `pieces`, `weight_kg`, `description`, `origin_emirate`, `deliver_by`, `max_attempts`, `require_code` | optional | `require_code: true` makes the rider enter the 4-digit code you pass to your customer |

Unknown fields are rejected. Response:
```json
{ "waybill": "DLV-2026-00042", "reference": "ORDER-1001", "status": "new", "emirate": "Dubai",
  "cod": { "amount": 249.5, "currency": "AED" }, "attempts": 0, "max_attempts": 3, "delivered_at": null,
  "delivery_code": null, "tracking_url": "https://…/t/…", "created_at": "…", "history": [], "created": true }
```
Statuses: `new`, `assigned`, `out_for_delivery`, `delivered`, `undelivered`, `return_to_sender`, `returned`, `cancelled`.

## Read
- `GET /api/v1/parcels/{waybill-or-reference}` — the parcel with a customer-safe `history`.
- `GET /api/v1/parcels?status=&limit=25&before={waybill}` — newest first, `limit` ≤ 100; pass `next_before` back as `before` for the next page.
- `GET /api/v1/remittances` — your COD payout statements (`being_prepared` → `paid`, with the bank reference).

## Cancel — `POST /api/v1/parcels/{waybill-or-reference}/cancel`
Only while the parcel is `new` (not yet on a run).

## Webhooks
Set an `https://` address under *Integrations* (port 443/8443, a public host name; private addresses are refused). We `POST` JSON `{ "id", "type", "created", "data" }`:

```
LBT-Signature: t=<unix>,v1=<hex>        v1 = HMAC-SHA256(secret, t + "." + rawBody)
LBT-Event-Id:  <same as id>
```
Verify the signature over the **raw** body, reject if `t` is more than 5 minutes old, de-duplicate on `id`, answer `2xx` within 10 s. Anything else is retried 12 times with growing back-off (about three hours in total), then parked; `410 Gone` stops delivery immediately. Redirects are not followed.

Types: `parcel.out_for_delivery`, `parcel.delivered` (`received_by`, `cod_collected_minor`), `parcel.attempt_failed` (`reason`, `attempt`, `max_attempts`, `will_return`), `parcel.return_to_sender`, `parcel.returned`, `parcel.cancelled`, `remittance.paid` (`paid_to_merchant_minor`, `fees_minor`, `bank_reference`). Each `data` carries `waybill`, `reference`, `status`, `attempts`. Events never contain the consignee's name, phone or address.
