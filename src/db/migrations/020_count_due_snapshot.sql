ALTER TABLE wh_count_schedules ADD COLUMN first_due date;
UPDATE wh_count_schedules p SET first_due=coalesce((SELECT min(due_on) FROM wh_count_schedule_runs r WHERE r.schedule_id=p.id),p.next_due);
ALTER TABLE wh_count_schedules ALTER COLUMN first_due SET NOT NULL;
ALTER TABLE wh_count_schedules ADD CONSTRAINT review_covers_first_due CHECK(valid_until>=first_due);
CREATE OR REPLACE FUNCTION count_schedule_contract_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.reference,NEW.warehouse_id,NEW.location_id,NEW.tier,NEW.interval_days,NEW.first_due,NEW.valid_until,NEW.counter_id,NEW.document_id,NEW.reviewer,NEW.scope,NEW.approved_by) IS DISTINCT FROM
 (OLD.tenant_id,OLD.reference,OLD.warehouse_id,OLD.location_id,OLD.tier,OLD.interval_days,OLD.first_due,OLD.valid_until,OLD.counter_id,OLD.document_id,OLD.reviewer,OLD.scope,OLD.approved_by)
 OR NEW.next_due<OLD.next_due OR (NOT OLD.active AND NEW.active)
 THEN RAISE EXCEPTION 'count schedule contract is immutable; disable and append a replacement';END IF;RETURN NEW;END $$;
