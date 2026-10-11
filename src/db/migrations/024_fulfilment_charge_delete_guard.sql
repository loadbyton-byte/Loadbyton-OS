CREATE OR REPLACE FUNCTION fulfil_charge_financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'fulfilment charge financial evidence is immutable'; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.party_id,NEW.code,NEW.description,NEW.qty,NEW.unit_minor,NEW.tax_code,NEW.source_key,NEW.order_id,NEW.entity_id,NEW.created_at) IS DISTINCT FROM
 (OLD.id,OLD.tenant_id,OLD.party_id,OLD.code,OLD.description,OLD.qty,OLD.unit_minor,OLD.tax_code,OLD.source_key,OLD.order_id,OLD.entity_id,OLD.created_at)
 THEN RAISE EXCEPTION 'fulfilment charge financial evidence is immutable';END IF;RETURN NEW;END $$;
DROP TRIGGER fulfil_charge_financial_guard ON fulfil_charges;
CREATE TRIGGER fulfil_charge_financial_guard BEFORE UPDATE OR DELETE ON fulfil_charges FOR EACH ROW EXECUTE FUNCTION fulfil_charge_financial_immutable();
