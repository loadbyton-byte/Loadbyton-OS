# Launch gates

Do not take paying customers until each gate is ticked with an owner and a date. The in-product readiness page (`/admin/readiness`) tracks the software-side gates; this list adds the business ones.

## Software and operations
- [ ] Hardening checklist complete (security/HARDENING_CHECKLIST.md)
- [ ] Restore drill passed and recorded; RPO/RTO measured
- [ ] Monitoring alerts reach a person; incident roles named (security/INCIDENT_RESPONSE.md)
- [ ] Each live provider tested in its sandbox first: payments, e-mail, SMS, e-invoicing, and any bank, carrier or marketplace connection offered to customers. Connections written from public documentation (DHL Express, Amazon, Magento, Google Routes, open-banking signing) have **not** been run against the live providers from this repository and must be proven in the provider's test environment before they are offered as working.
- [ ] Load and abuse test at the expected first-year volume

## Legal and finance
- [ ] Trade licence and the right activity on it for software provision and, if applicable, payment handling
- [ ] Customer terms, privacy notice, data-processing terms, acceptable-use policy reviewed by a UAE lawyer
- [ ] VAT registration status confirmed with a tax adviser; invoice format and e-invoicing obligations confirmed
- [ ] Business bank account; payment-provider account approved for this business model
- [ ] Insurance quoted: professional indemnity / technology errors and omissions, cyber, general liability

## Commercial
- [ ] Prices confirmed (current prices are planning hypotheses)
- [ ] Sector claims on the public site match what is verified; sectors not independently reviewed stay labelled as such
- [ ] Support hours and response targets published and staffed
- [ ] Refund and cancellation policy published
