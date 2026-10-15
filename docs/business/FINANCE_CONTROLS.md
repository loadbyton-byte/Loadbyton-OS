# Finance controls

- **Segregation:** the person who records a cash receipt, refund, write-off or certificate is never the person who approves it; the product enforces this for COD cash, variances, counts, write-offs, certificates and refunds.
- **Payments:** hosted checkout only; no card data on our servers. Daily check of rejected or ignored provider events; every refund goes through the provider and then the review queue.
- **Reconciliation:** monthly, bank statement ↔ ledger (native ledger or exported to the accounting system) ↔ payment-provider payouts. Differences are explained in writing.
- **Foreign exchange:** realised FX is booked on receipts; month-end revaluation of open foreign balances is run and reviewed.
- **VAT:** tax codes are set per document; the tax adviser reviews the setup before launch and each filing.
- **Delegation of authority:** write down who may approve refunds above a limit, discounts, credit terms and contract exceptions. Owner sets the limits.
- **Records:** keep invoices, receipts and contracts for the period the law requires (confirm with the tax adviser); the audit log is immutable.
- **Platform-fee vs customer money:** customer cash collected on their behalf (COD, deposits, guarantees) is tracked as client money in the product and must not be used for operating costs.
