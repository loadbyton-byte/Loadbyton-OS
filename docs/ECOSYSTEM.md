# Link with loadbyton.com

The Store side of the loadbyton.com ↔ loadbyton.store link. The full contract, entitlement rules, operations and launch checklist are in the marketplace repository's `docs/ECOSYSTEM.md` (`loadbyton-byte/Project-Loadbyton`); this page covers what this repository does.

**Off by default.** Nothing here runs until `ECOSYSTEM_SHARED_SECRET` (and, for sign-in, `COM_BASE_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`) are set. `npm run preflight` fails a production start with a half-configured link.

## What it does

* **Receives entitlement events** at `POST /webhooks/loadbyton`. Each is verified (`LBT-Signature`, 5-minute window, raw body), de-duplicated on its id (`ecosystem_inbox`), ordered by `version` (`ecosystem_orgs.last_version`) and applied to the linked workspace. Until a workspace exists the state is held in `ecosystem_orgs`.
* **Applies two included plans**, `starter_included` and `enterprise_included` (`src/platform/ecosystem.ts`). They reuse the Starter and Enterprise ceilings at no price, are created lazily as immutable plan versions, are excluded from the public tariff (`currentPlans`), and keep `period_end` null so the renewal loop never touches them. loadbyton.com sends the change at a period end.
* **Never overrides a paid plan.** A workspace paying for an equal or higher plan is left alone (`kept_higher_paid`); a suspension never restricts a workspace that was not on an included plan.
* **Grace** keeps the plan and stays writable (`subscriptions.status = 'grace'`). **Suspension** (company no longer verified) maps to `restricted`: read and export only. Nothing is deleted; `previewPlanChange` records which limits current data now exceeds.
* **Fails safe.** The `ecosystem` worker ends Enterprise Included at its own `ends_at` / `grace_until` if loadbyton.com has gone quiet, and every 15 minutes reads loadbyton.com's signed grant list to repair missed webhooks.
* **"Continue with Loadbyton"** (`/auth/loadbyton`): OIDC code flow with PKCE, state and nonce; the code is exchanged server to server; the ID token is verified (RS256 via JWKS, issuer, audience, expiry, nonce). The browser holds only a signed 10-minute flow cookie.
* **Accounts**: a returning person is found through `identity_links`. A new person gets an account with an unusable password. An existing local account with the same email is **not** linked by email: it must enter its password (`/auth/loadbyton/link`). Platform staff are excluded.
* **Workspaces** are created only on the company administrator's first sign-in, after the administrator activated Business OS on loadbyton.com, and use the sector chosen there. Other people join through invitations. Company MFA rules apply as for any session.

## Tests

`tests/ecosystem.test.ts` (17 tests): signature, webhook without cookie or form token, schema rejection, ordering and replay, plan changes, grace and suspension, no-downgrade, tariff exclusion, fail-safe, reconciliation, and the whole OIDC callback including tampered tokens and the account-linking rule.
