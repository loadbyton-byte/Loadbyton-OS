ALTER TABLE trip_expense_receipts ADD COLUMN version int;
DROP TRIGGER trip_receipt_immutable ON trip_expense_receipts;
WITH ranked AS(SELECT id,row_number() OVER(PARTITION BY tenant_id,expense_id ORDER BY created_at,id) AS version FROM trip_expense_receipts)
UPDATE trip_expense_receipts r SET version=ranked.version FROM ranked WHERE ranked.id=r.id;
ALTER TABLE trip_expense_receipts ALTER COLUMN version SET NOT NULL;
ALTER TABLE trip_expense_receipts ADD CONSTRAINT receipt_positive_version CHECK(version>0);
ALTER TABLE trip_expense_receipts ADD CONSTRAINT receipt_version_unique UNIQUE(tenant_id,expense_id,version);
CREATE TRIGGER trip_receipt_immutable BEFORE UPDATE OR DELETE ON trip_expense_receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE FUNCTION expense_latest_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status='approved' AND NEW.evidence_required AND NEW.approved_receipt_id IS DISTINCT FROM
 (SELECT id FROM trip_expense_receipts WHERE expense_id=NEW.id ORDER BY version DESC LIMIT 1)
 THEN RAISE EXCEPTION 'expense approval must use its latest receipt version';END IF;RETURN NEW;END $$;
CREATE TRIGGER expense_latest_receipt_guard BEFORE UPDATE ON trip_expenses FOR EACH ROW EXECUTE FUNCTION expense_latest_receipt();
