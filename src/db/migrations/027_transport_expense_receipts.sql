ALTER TABLE trip_expenses ADD CONSTRAINT trip_expense_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE trip_expenses ADD COLUMN evidence_required boolean NOT NULL DEFAULT true;
UPDATE trip_expenses SET evidence_required=false WHERE status<>'recorded';
CREATE TABLE trip_expense_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),expense_id uuid NOT NULL,document_id uuid NOT NULL,
 reference uuid NOT NULL,linked_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,expense_id) REFERENCES trip_expenses(tenant_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,expense_id,reference)
);
ALTER TABLE trip_expenses ADD COLUMN approved_receipt_id uuid;
ALTER TABLE trip_expenses ADD CONSTRAINT approved_expense_receipt FOREIGN KEY(tenant_id,approved_receipt_id) REFERENCES trip_expense_receipts(tenant_id,id);
CREATE TRIGGER trip_receipt_immutable BEFORE UPDATE OR DELETE ON trip_expense_receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE FUNCTION trip_expense_integrity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'expense financial evidence is immutable';END IF;
 IF TG_OP='INSERT' THEN IF NOT NEW.evidence_required OR NEW.status<>'recorded' OR NEW.approved_receipt_id IS NOT NULL THEN RAISE EXCEPTION 'new expenses must await evidence and independent review';END IF;RETURN NEW;END IF;
 IF OLD.status<>'recorded' OR NEW.status NOT IN ('approved','rejected') OR
 (NEW.id,NEW.tenant_id,NEW.trip_id,NEW.kind,NEW.amount_minor,NEW.note,NEW.client_event_id,NEW.recorded_by,NEW.created_at,NEW.evidence_required) IS DISTINCT FROM
 (OLD.id,OLD.tenant_id,OLD.trip_id,OLD.kind,OLD.amount_minor,OLD.note,OLD.client_event_id,OLD.recorded_by,OLD.created_at,OLD.evidence_required)
 THEN RAISE EXCEPTION 'expense financial evidence is immutable';END IF;
 IF NEW.status='approved' AND NEW.evidence_required AND (NEW.decided_by IS NULL OR NEW.decided_by=NEW.recorded_by OR NOT EXISTS
 (SELECT 1 FROM trip_expense_receipts r JOIN documents d ON d.id=r.document_id WHERE r.id=NEW.approved_receipt_id AND r.expense_id=NEW.id AND d.trip_id=NEW.trip_id AND d.status='issued' AND NOT d.hold AND d.kind IN ('supplier_invoice','other')))
 THEN RAISE EXCEPTION 'expense approval requires current issued receipt and an independent approver';END IF;RETURN NEW;END $$;
CREATE TRIGGER trip_expense_guard BEFORE INSERT OR UPDATE OR DELETE ON trip_expenses FOR EACH ROW EXECUTE FUNCTION trip_expense_integrity();
ALTER TABLE trip_expense_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON trip_expense_receipts USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON trip_expense_receipts TO lbt_app;
