ALTER TABLE customs_cases ADD COLUMN entity_id uuid;
ALTER TABLE customs_cases ADD FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id);
ALTER TABLE customs_cases ADD COLUMN fee_minor bigint NOT NULL DEFAULT 0 CHECK(fee_minor>=0);
ALTER TABLE customs_cases ADD COLUMN tax_code text NOT NULL DEFAULT 'SR5';
ALTER TABLE customs_cases ADD COLUMN permit_required boolean NOT NULL DEFAULT false;
ALTER TABLE customs_cases ADD COLUMN invoice_id uuid;
ALTER TABLE customs_cases ADD FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id);
ALTER TABLE customs_cases ADD COLUMN financial_status text NOT NULL DEFAULT 'open' CHECK(financial_status IN ('open','invoiced','collected'));
ALTER TABLE invoices ADD COLUMN customs_case_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY(tenant_id,customs_case_id) REFERENCES customs_cases(tenant_id,id);
CREATE FUNCTION customs_fee_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.party_id,NEW.entity_id,NEW.fee_minor,NEW.tax_code,NEW.permit_required) IS DISTINCT FROM
 (OLD.tenant_id,OLD.party_id,OLD.entity_id,OLD.fee_minor,OLD.tax_code,OLD.permit_required)
 THEN RAISE EXCEPTION 'customs fee contract is immutable'; END IF;RETURN NEW;END $$;
CREATE TRIGGER customs_fee_immutable BEFORE UPDATE ON customs_cases FOR EACH ROW EXECUTE FUNCTION customs_fee_immutable();
