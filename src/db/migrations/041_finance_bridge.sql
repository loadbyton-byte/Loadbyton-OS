-- Finance bridge: credit notes, receipt reversals, receipt/credit-note sync state, supplier bills and payments with approved FX rates.

-- ── invoices carry credited value; balance is derived, so every outstanding query reads one column
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('issued','part_paid','paid','void','credited'));
ALTER TABLE invoices ADD COLUMN credited_minor bigint NOT NULL DEFAULT 0 CHECK (credited_minor >= 0);
ALTER TABLE invoices ADD COLUMN balance_minor bigint GENERATED ALWAYS AS (total_minor - paid_minor - credited_minor) STORED;
ALTER TABLE invoices ADD CONSTRAINT invoices_settled_within_total CHECK (paid_minor + credited_minor <= total_minor);

ALTER TABLE receipts ADD UNIQUE (tenant_id, id);
ALTER TABLE receipts ADD COLUMN external_id text;
ALTER TABLE receipts ADD COLUMN sync_status text NOT NULL DEFAULT 'not_connected' CHECK (sync_status IN ('not_connected','manual','pending','synced','failed'));
CREATE TABLE receipt_reversals (
 receipt_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), reason text NOT NULL, reversed_by uuid NOT NULL REFERENCES users(id), at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, receipt_id) REFERENCES receipts(tenant_id, id)
);
CREATE TRIGGER receipt_reversals_immutable BEFORE UPDATE OR DELETE ON receipt_reversals FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ── credit notes: drafted by one person, issued by another; immutable once issued; numbered only when issued (no gaps)
CREATE TABLE credit_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), no text, invoice_id uuid NOT NULL, entity_id uuid NOT NULL, party_id uuid NOT NULL,
 currency text NOT NULL, reason text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
 subtotal_minor bigint NOT NULL CHECK (subtotal_minor > 0), tax_minor bigint NOT NULL CHECK (tax_minor >= 0), total_minor bigint NOT NULL,
 drafted_by uuid NOT NULL REFERENCES users(id), issued_by uuid REFERENCES users(id), issued_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 external_id text, sync_status text NOT NULL DEFAULT 'not_connected' CHECK (sync_status IN ('not_connected','manual','pending','synced','failed')),
 FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id), FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id), FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
 UNIQUE (tenant_id, id), CHECK (total_minor = subtotal_minor + tax_minor), CHECK ((status = 'issued') = (no IS NOT NULL AND issued_by IS NOT NULL AND issued_at IS NOT NULL))
);
CREATE UNIQUE INDEX credit_notes_no_unique ON credit_notes (tenant_id, no) WHERE no IS NOT NULL;
CREATE TABLE credit_note_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), credit_note_id uuid NOT NULL, invoice_line_id uuid, description text NOT NULL,
 qty numeric(12,3) NOT NULL CHECK (qty > 0), unit_minor bigint NOT NULL CHECK (unit_minor >= 0), tax_code text NOT NULL, net_minor bigint NOT NULL, tax_minor bigint NOT NULL,
 FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes(tenant_id, id)
);
CREATE FUNCTION credit_note_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credit notes are never deleted'; END IF;
 IF OLD.status = 'issued' AND (NEW.status <> 'issued' OR NEW.no IS DISTINCT FROM OLD.no OR NEW.total_minor <> OLD.total_minor OR NEW.invoice_id <> OLD.invoice_id) THEN RAISE EXCEPTION 'an issued credit note is final'; END IF;
 IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'a cancelled draft cannot change'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER credit_note_guard BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION credit_note_guard();
CREATE FUNCTION credit_note_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS (SELECT 1 FROM credit_notes WHERE id = coalesce(OLD.credit_note_id, NEW.credit_note_id) AND status <> 'draft') THEN RAISE EXCEPTION 'lines of an issued credit note are final'; END IF;
 RETURN coalesce(NEW, OLD); END $$;
CREATE TRIGGER credit_note_line_guard BEFORE UPDATE OR DELETE ON credit_note_lines FOR EACH ROW EXECUTE FUNCTION credit_note_line_guard();

-- ── approved exchange rates (never defaulted): entered by one person, approved by another
CREATE TABLE fx_rates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), from_ccy text NOT NULL, to_ccy text NOT NULL CHECK (to_ccy <> from_ccy),
 rate numeric(18,8) NOT NULL CHECK (rate > 0), as_of date NOT NULL, source text NOT NULL, status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
 entered_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id), decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, from_ccy, to_ccy, as_of), CHECK ((status = 'proposed') = (approved_by IS NULL))
);
CREATE FUNCTION fx_rate_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'exchange rates are never deleted'; END IF;
 IF OLD.status <> 'proposed' THEN RAISE EXCEPTION 'a decided exchange rate is final'; END IF;
 IF NEW.rate <> OLD.rate OR NEW.as_of <> OLD.as_of OR NEW.from_ccy <> OLD.from_ccy OR NEW.to_ccy <> OLD.to_ccy THEN RAISE EXCEPTION 'propose a new rate instead of editing one'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER fx_rate_guard BEFORE UPDATE OR DELETE ON fx_rates FOR EACH ROW EXECUTE FUNCTION fx_rate_guard();

-- ── supplier bills (payables) and payments
ALTER TABLE job_costs ADD UNIQUE (tenant_id, id);
CREATE TABLE vendor_bills (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), entity_id uuid NOT NULL, no text NOT NULL, supplier_id uuid NOT NULL, supplier_ref text NOT NULL,
 bill_date date NOT NULL, due_date date NOT NULL CHECK (due_date >= bill_date), currency text NOT NULL, base_currency text NOT NULL,
 subtotal_minor bigint NOT NULL CHECK (subtotal_minor > 0), tax_minor bigint NOT NULL CHECK (tax_minor >= 0), total_minor bigint NOT NULL, paid_minor bigint NOT NULL DEFAULT 0,
 fx_rate numeric(18,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0), base_total_minor bigint, base_tax_minor bigint,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','part_paid','paid','void')), document_id uuid, variance_note text, void_reason text,
 entered_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id), approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id), FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id), FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, no), CHECK (total_minor = subtotal_minor + tax_minor), CHECK (paid_minor BETWEEN 0 AND total_minor),
 CHECK (status = 'draft' OR status = 'void' OR (approved_by IS NOT NULL AND base_total_minor IS NOT NULL AND document_id IS NOT NULL))
);
CREATE UNIQUE INDEX vendor_bills_supplier_ref_unique ON vendor_bills (tenant_id, supplier_id, lower(supplier_ref)) WHERE status <> 'void';
CREATE TABLE vendor_bill_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), bill_id uuid NOT NULL, description text NOT NULL, net_minor bigint NOT NULL CHECK (net_minor > 0),
 tax_code text NOT NULL, tax_minor bigint NOT NULL CHECK (tax_minor >= 0), job_cost_id uuid,
 FOREIGN KEY (tenant_id, bill_id) REFERENCES vendor_bills(tenant_id, id), FOREIGN KEY (tenant_id, job_cost_id) REFERENCES job_costs(tenant_id, id)
);
CREATE UNIQUE INDEX vendor_bill_lines_cost_unique ON vendor_bill_lines (job_cost_id) WHERE job_cost_id IS NOT NULL;
CREATE TABLE vendor_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), bill_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor > 0), paid_on date NOT NULL,
 method text NOT NULL, reference text, fx_rate_paid numeric(18,8) NOT NULL DEFAULT 1 CHECK (fx_rate_paid > 0), base_paid_minor bigint NOT NULL, base_bill_minor bigint NOT NULL, fx_gain_loss_minor bigint NOT NULL,
 paid_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (tenant_id, bill_id) REFERENCES vendor_bills(tenant_id, id),
 CHECK (fx_gain_loss_minor = base_bill_minor - base_paid_minor)
);
CREATE TRIGGER vendor_payments_immutable BEFORE UPDATE OR DELETE ON vendor_payments FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['receipt_reversals','credit_notes','credit_note_lines','fx_rates','vendor_bills','vendor_bill_lines','vendor_payments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON credit_notes, fx_rates, vendor_bills TO lbt_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON credit_note_lines, vendor_bill_lines TO lbt_app;
GRANT SELECT,INSERT ON receipt_reversals, vendor_payments TO lbt_app;
