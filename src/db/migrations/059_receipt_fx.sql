-- Realised FX on customer receipts and revaluation of foreign-currency receivables.
-- A receipt against an invoice billed in a foreign currency may record the amount actually paid in that currency and the approved rate on the day:
-- amount_minor stays the base-currency carrying value that settles the invoice, cash_minor is the base-currency value received, the difference is the realised gain or loss.
ALTER TABLE receipts ADD COLUMN cash_minor bigint CHECK (cash_minor IS NULL OR cash_minor > 0), ADD COLUMN billing_amount_minor bigint CHECK (billing_amount_minor IS NULL OR billing_amount_minor > 0),
 ADD COLUMN settlement_rate numeric(18,8) CHECK (settlement_rate IS NULL OR settlement_rate > 0), ADD COLUMN settlement_rate_id uuid,
 ADD CONSTRAINT receipts_fx_complete CHECK ((cash_minor IS NULL) = (billing_amount_minor IS NULL) AND (cash_minor IS NULL) = (settlement_rate IS NULL));

-- Period-end revaluation of open foreign-currency receivables at an approved rate: an immutable run with one line per invoice.
CREATE TABLE fx_revaluations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), as_of date NOT NULL, net_minor bigint NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, as_of), UNIQUE (tenant_id, id)
);
CREATE TABLE fx_revaluation_lines (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), revaluation_id uuid NOT NULL, invoice_id uuid NOT NULL, currency text NOT NULL,
 billing_open_minor bigint NOT NULL, carrying_minor bigint NOT NULL, rate numeric(18,8) NOT NULL, rate_id uuid NOT NULL, revalued_minor bigint NOT NULL, diff_minor bigint NOT NULL,
 FOREIGN KEY (tenant_id, revaluation_id) REFERENCES fx_revaluations(tenant_id, id), FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
 CHECK (diff_minor = revalued_minor - carrying_minor), UNIQUE (revaluation_id, invoice_id)
);
CREATE TRIGGER fx_revaluations_immutable BEFORE UPDATE OR DELETE ON fx_revaluations FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER fx_revaluation_lines_immutable BEFORE UPDATE OR DELETE ON fx_revaluation_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['fx_revaluations','fx_revaluation_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT ON fx_revaluations, fx_revaluation_lines TO lbt_app;
GRANT USAGE,SELECT ON SEQUENCE fx_revaluation_lines_id_seq TO lbt_app;
