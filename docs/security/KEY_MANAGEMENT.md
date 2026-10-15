# Key and secret management

| Secret | Where it lives | Rotation | How |
|---|---|---|---|
| Database owner (migration) string | `.env.production`, owner's password manager | on leaver, on suspicion, yearly | change in Supabase, update env, redeploy |
| Application database string (`lbt_app`) | `.env.production` | same | same |
| Data-encryption key (`MFA_ENCRYPTION_KEY` (with `MFA_ENCRYPTION_PREVIOUS_KEY` during rotation)) | `.env.production` + sealed offline copy | yearly or on suspicion | `npm run rotate-encryption-key` (dual-key, re-encrypts stored secrets) |
| Session secret | `.env.production` | yearly or on suspicion | `npm run rotate-session-secret` (re-seals feed, carrier and device secrets) |
| Backup encryption key (`BACKUP_ENCRYPTION_KEY`) | `.env.production` + offline copy held separately from the backups | yearly | `npm run rotate-backup-key` |
| Payment provider API and webhook secrets | provider console + env | on leaver or suspicion | roll in the provider, update env |
| Customer provider credentials (feeds, carriers, marketplaces) | database, sealed | customer's responsibility; staff can force re-entry | covered by the session-secret rotation |
| Cloudflare tunnel token, R2 tokens, Upstash, Sentry | env | on leaver or suspicion | regenerate in the provider |
| AWS access | IAM identities with MFA; GitHub deploys use OIDC (no stored keys) | n/a | |

## Rules
- Secrets are never committed (gitleaks runs in CI), never pasted into tickets or chat, never logged.
- The offline copy of the encryption and backup keys is held by the owner in a sealed location separate from the backups; **losing both the key and the live copy makes encrypted data unrecoverable**. Test restore with the offline copy once a year.
- After a suspected leak: rotate first, investigate second.
- The RF terminal carries PINs in the clear over the local network: use it only inside the warehouse network or a VPN, and treat a PIN as low-value (it is a second factor for an existing user, locked after five failures).
