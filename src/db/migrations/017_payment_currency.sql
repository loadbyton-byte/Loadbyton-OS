ALTER TABLE orders ADD COLUMN payment_currency text;
ALTER TABLE orders ADD COLUMN payment_total_minor bigint CHECK(payment_total_minor>0);
ALTER TABLE orders ADD COLUMN fx_rate numeric;
ALTER TABLE orders ADD COLUMN fx_note text;
CREATE OR REPLACE FUNCTION protect_order_contract() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.plan_version_id,NEW.lines,NEW.currency,NEW.subtotal_minor,NEW.tax_minor,NEW.total_minor,NEW.tax_note,NEW.reference,NEW.provider,NEW.created_by,NEW.merchant_snapshot,NEW.payment_currency,NEW.payment_total_minor,NEW.fx_rate,NEW.fx_note)
 IS DISTINCT FROM
 (OLD.tenant_id,OLD.plan_version_id,OLD.lines,OLD.currency,OLD.subtotal_minor,OLD.tax_minor,OLD.total_minor,OLD.tax_note,OLD.reference,OLD.provider,OLD.created_by,OLD.merchant_snapshot,OLD.payment_currency,OLD.payment_total_minor,OLD.fx_rate,OLD.fx_note)
 THEN RAISE EXCEPTION 'order contract is immutable'; END IF;RETURN NEW;END $$;
