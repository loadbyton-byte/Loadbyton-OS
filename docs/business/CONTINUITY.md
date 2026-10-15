# Business continuity

| Scenario | First actions | Target |
|---|---|---|
| Owner or technical owner unavailable | named deputy has break-glass access held in a sealed envelope or vault entry; runbooks are in `docs/RUNBOOKS.md` | deputy can restore service |
| Instance lost | Terraform rebuild, restore latest backup, `npm run verify`, repoint tunnel | RTO 8 h (to be proven) |
| Database provider outage | use provider status page; restore to an alternative Postgres from the nightly backup if the outage is long | decide at 2 h |
| Cloudflare outage | status page; no workaround for DNS/TLS in the lean setup; tell customers | wait |
| Payment provider outage | customers keep working; reconcile when restored | n/a |
| E-mail or SMS provider outage | queued messages retry; switch provider by environment setting | 1 business day |
| Key compromise | rotate per security/KEY_MANAGEMENT.md | same day |
| Customer wants to leave | export workspace data (`/app` export), certify deletion after the agreed period | per contract |

Customer communication during an outage: status page `/status`, plus direct e-mail for affected customers.
