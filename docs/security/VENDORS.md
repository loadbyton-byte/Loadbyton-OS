# Vendor and sub-processor register

The owner fills in the contract date, data-processing terms status and region. Review each vendor yearly and before adding a new one.

| Vendor | Purpose | Data they see | Region | DPA signed | Last review |
|---|---|---|---|---|---|
| AWS | server (EC2), SSM, SES (optional) | everything in transit/at rest on the instance | ap-south-1 (set in Terraform) | | |
| Supabase or Neon | PostgreSQL | all application data | | | |
| Cloudflare | DNS, TLS, tunnel, WAF, R2 object storage | traffic, files | | | |
| Upstash | shared rate limits | IP-derived keys | | | |
| Sentry | error reports | error context (scrubbed) | | | |
| Stripe / Razorpay | payments | billing contact, card data (hosted checkout; not stored by us) | | | |
| E-mail provider (Resend/SES) | transactional mail | recipient addresses, message text | | | |
| SMS/WhatsApp provider | verification codes, notifications | mobile numbers | | | |
| Customer-chosen providers (banks, marketplaces, carriers, e-invoicing) | acting for the customer | per the customer's own agreement | | customer's | |

## Review checklist
Security certifications or audit reports available? Data location and sub-processors? Breach-notice commitment? Export and deletion on exit? Uptime history? What happens to us if they fail (fallback)? Price change terms?
