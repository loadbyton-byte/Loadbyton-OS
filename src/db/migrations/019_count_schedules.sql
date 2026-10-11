CREATE TABLE wh_count_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),reference uuid NOT NULL,
 warehouse_id uuid NOT NULL,location_id uuid,tier text NOT NULL CHECK(tier IN ('high_value','standard','low_value')),
 interval_days int NOT NULL CHECK(interval_days BETWEEN 1 AND 365),next_due date NOT NULL,valid_until date NOT NULL,
 counter_id uuid NOT NULL REFERENCES users(id),document_id uuid NOT NULL,reviewer text NOT NULL,scope text NOT NULL,
 approved_by uuid NOT NULL REFERENCES users(id),active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),FOREIGN KEY(tenant_id,location_id) REFERENCES warehouse_locations(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,reference)
);
CREATE UNIQUE INDEX one_active_location_schedule ON wh_count_schedules(tenant_id,location_id) WHERE active AND location_id IS NOT NULL;
CREATE UNIQUE INDEX one_active_warehouse_schedule ON wh_count_schedules(tenant_id,warehouse_id) WHERE active AND location_id IS NULL;
ALTER TABLE wh_counts ADD COLUMN assigned_to uuid REFERENCES users(id);
CREATE TABLE wh_count_schedule_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),schedule_id uuid NOT NULL,due_on date NOT NULL,count_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES wh_count_schedules(tenant_id,id),FOREIGN KEY(tenant_id,count_id) REFERENCES wh_counts(tenant_id,id),
 UNIQUE(tenant_id,schedule_id,due_on),UNIQUE(tenant_id,count_id)
);
CREATE FUNCTION count_schedule_contract_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.reference,NEW.warehouse_id,NEW.location_id,NEW.tier,NEW.interval_days,NEW.valid_until,NEW.counter_id,NEW.document_id,NEW.reviewer,NEW.scope,NEW.approved_by) IS DISTINCT FROM
 (OLD.tenant_id,OLD.reference,OLD.warehouse_id,OLD.location_id,OLD.tier,OLD.interval_days,OLD.valid_until,OLD.counter_id,OLD.document_id,OLD.reviewer,OLD.scope,OLD.approved_by)
 THEN RAISE EXCEPTION 'count schedule contract is immutable; disable and append a replacement';END IF;RETURN NEW;END $$;
CREATE TRIGGER immutable_schedule_contract BEFORE UPDATE ON wh_count_schedules FOR EACH ROW EXECUTE FUNCTION count_schedule_contract_immutable();
CREATE FUNCTION count_schedule_run_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'count schedule run evidence is immutable';END $$;
CREATE TRIGGER immutable_schedule_run BEFORE UPDATE OR DELETE ON wh_count_schedule_runs FOR EACH ROW EXECUTE FUNCTION count_schedule_run_immutable();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['wh_count_schedules','wh_count_schedule_runs'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON wh_count_schedules TO lbt_app;
GRANT SELECT,INSERT ON wh_count_schedule_runs TO lbt_app;
