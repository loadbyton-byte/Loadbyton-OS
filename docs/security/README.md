# Security and operations pack

These are working policies for running LOAD|BY|TON as a business. They are written for the current stack (one EC2 instance, Supabase, R2, Cloudflare) and the controls already in the code. They are **drafts for the owner and a qualified adviser to adopt**: nothing here has been reviewed by a lawyer, auditor or insurer, no certification (ISO 27001, SOC 2, PCI) is claimed, and every name, date and contact must be filled in by the owner. Where a policy needs a person, the role is named, not invented.

| Document | Purpose |
|---|---|
| [ACCESS_CONTROL.md](ACCESS_CONTROL.md) | Who may reach production, staff roles, joiner/leaver steps |
| [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) | Severity levels, first hour, customer and regulator notice, post-mortem |
| [KEY_MANAGEMENT.md](KEY_MANAGEMENT.md) | Which secrets exist, who holds them, how and when each is rotated |
| [DATA_PROTECTION.md](DATA_PROTECTION.md) | Personal data map, retention, requests, UAE PDPL points to confirm with counsel |
| [VENDORS.md](VENDORS.md) | Sub-processor register and review checklist |
| [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) | Targets, drill schedule, evidence to keep |
| [HARDENING_CHECKLIST.md](HARDENING_CHECKLIST.md) | Launch gate: infrastructure, application, account settings |
| [CONTACTS.md](CONTACTS.md) | Fill-in sheet for people and providers |

The business side is in [../business/](../business/README.md).
