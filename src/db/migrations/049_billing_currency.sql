-- Foreign-currency customer invoicing. The books stay in the entity's currency (receipts, ageing, accounting sync and credit notes all remain there); an invoice may
-- additionally carry the customer's billing currency at an approved exchange rate, with every line shown in both currencies and VAT stated in the base currency.
ALTER TABLE parties ADD COLUMN billing_currency text CHECK (billing_currency IS NULL OR billing_currency ~ '^[A-Z]{3}$');
ALTER TABLE invoices
 ADD COLUMN billing_currency text CHECK (billing_currency IS NULL OR billing_currency ~ '^[A-Z]{3}$'),
 ADD COLUMN fx_rate numeric(18,8) CHECK (fx_rate IS NULL OR fx_rate > 0), ADD COLUMN fx_rate_id uuid, ADD COLUMN fx_rate_as_of date,
 ADD COLUMN billing_subtotal_minor bigint, ADD COLUMN billing_tax_minor bigint, ADD COLUMN billing_total_minor bigint,
 ADD CONSTRAINT invoices_billing_complete CHECK ((billing_currency IS NULL) = (fx_rate IS NULL) AND (billing_currency IS NULL) = (billing_total_minor IS NULL) AND (billing_currency IS NULL) = (fx_rate_id IS NULL)),
 ADD CONSTRAINT invoices_billing_sum CHECK (billing_total_minor IS NULL OR billing_total_minor = billing_subtotal_minor + billing_tax_minor);
ALTER TABLE invoice_lines ADD COLUMN billing_unit_minor bigint, ADD COLUMN billing_net_minor bigint, ADD COLUMN billing_tax_minor bigint;
