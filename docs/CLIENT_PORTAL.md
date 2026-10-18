# Client portal and brochure flow

Runs when `BROCHURE_MODE` is on (the default). Code map and operating notes.

## Journey
public site → `/start` (account + request + brand kit) → `/app` dashboard → delivery → client adds private details → optional add-ons.

## Delivery clock
`service_requests.clock_started_at` is set only when all hold:
- `brand_ready_at` is set (client confirmed the brand kit; `markBrandReady`)
- free request, OR paid with `quote_note` (staff quote, or `onOrderPaid` for a monthly plan, or "covered by current plan")

`waitingFor()` lists what a request still needs (`brand`, `quote`, `payment`). `due_at` is meaningless until the clock starts.

## Modules
| Concern | File |
|---|---|
| Features, plans, selection rules | `src/platform/features.ts` (defaults), `feature-settings.ts` (staff overrides, table `feature_settings`) |
| Sector detail text | `src/platform/sector-content.ts` |
| Brand kit, files, theme export | `src/platform/brand-kit.ts` |
| Messages | `src/platform/messages.ts` (immutable, private-data guard, email without text) |
| Private-details guide | `src/platform/private-guide.ts`, `src/lib/private-data.ts` |
| Requests, clock, reminders, refunds | `src/platform/requests.ts` |
| Pay for a plan-backed request | `src/platform/request-plan.ts` (+ `onOrderPaid` hook in `billing.ts`) |
| Client pages | `src/web/portal.tsx`; staff pages in `src/web/requests.tsx` |
| Public pages | `src/web/brochure.tsx`, `home.tsx`, `public.tsx` |

## Staff
- `/admin/requests` queue; `/admin/requests/:id` brand kit, files, theme download (`brand-theme.css|json`), thread, update.
- `/admin/features` switch add-ons off or move them between plans (new requests only).
- `/admin/tenants/:id` plan and payments.

## Automation
- Worker `reminders` (hourly): brand-kit reminder after 24 h, then every 3 days, max 4.
- Emails (outbox → `mailHandlers`): `request_reply`, `client_message`, `request_status`, `brand_reminder`. None carries message text.
- Refund of a plan order adds a timeline note on the requests it backed.

## Not covered
Live Stripe/Razorpay acceptance, Arabic translation of the new pages, legal review of the text, independent sector acceptance, a bank-details block in the product's invoice layout.
