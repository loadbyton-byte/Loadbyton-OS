CREATE OR REPLACE FUNCTION cod_cash_bounds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parcel uuid;delta bigint;recovered bigint;candidate bigint;new_recovery bigint:=0;paid bigint;expected bigint;collected bigint;received bigint;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':delivery',0));
 IF TG_TABLE_NAME='delivery_cash_adjustment_decisions' THEN
  IF NOT EXISTS(SELECT 1 FROM memberships WHERE tenant_id=NEW.tenant_id AND user_id=NEW.decided_by AND active AND roles && ARRAY['owner','finance']::text[]) THEN RAISE EXCEPTION 'COD cash decision requires current finance authority';END IF;
  IF NOT NEW.approved THEN RETURN NEW;END IF;
  SELECT parcel_id,CASE WHEN kind IN ('recovery','correction_in') THEN amount_minor ELSE -amount_minor END,CASE WHEN kind='recovery' THEN amount_minor ELSE 0 END INTO parcel,candidate,new_recovery FROM delivery_cash_adjustments WHERE id=NEW.adjustment_id AND tenant_id=NEW.tenant_id;
 ELSE parcel:=NEW.parcel_id;candidate:=0;END IF;
 SELECT expected_minor,collected_minor,received_minor INTO expected,collected,received FROM delivery_cod_decisions WHERE parcel_id=parcel AND tenant_id=NEW.tenant_id;
 IF expected IS NULL THEN RAISE EXCEPTION 'COD cash requires an existing reconciliation';END IF;
 SELECT coalesce(sum(CASE WHEN a.kind IN ('recovery','correction_in') THEN a.amount_minor ELSE -a.amount_minor END),0),coalesce(sum(CASE WHEN a.kind='recovery' THEN a.amount_minor ELSE 0 END),0) INTO delta,recovered FROM delivery_cash_adjustments a JOIN delivery_cash_adjustment_decisions d ON d.adjustment_id=a.id AND d.approved WHERE a.parcel_id=parcel AND a.tenant_id=NEW.tenant_id;
 SELECT coalesce(sum(amount_minor),0) INTO paid FROM delivery_remittances WHERE parcel_id=parcel AND tenant_id=NEW.tenant_id;
 IF TG_TABLE_NAME='delivery_remittances' THEN paid:=paid+NEW.amount_minor;END IF;
 IF received+delta+candidate<0 OR paid>least(expected,collected+recovered+new_recovery,received+delta+candidate) THEN RAISE EXCEPTION 'COD cash change exceeds available cash or reverses an existing remittance';END IF;
 RETURN NEW;
END $$;
