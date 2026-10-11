ALTER TABLE documents ADD COLUMN delivery_parcel_id uuid;
ALTER TABLE documents ADD CONSTRAINT document_delivery_parcel FOREIGN KEY(tenant_id,delivery_parcel_id) REFERENCES delivery_parcels(tenant_id,id);
CREATE TABLE delivery_cash_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),parcel_id uuid NOT NULL,reference uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('recovery','refund','correction_in','correction_out')),amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 1 AND 1000000000),
 document_id uuid NOT NULL,reason text NOT NULL,requested_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,parcel_id) REFERENCES delivery_parcels(tenant_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,reference)
);
CREATE TABLE delivery_cash_adjustment_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),adjustment_id uuid NOT NULL,approved boolean NOT NULL,reason text NOT NULL,decided_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,adjustment_id) REFERENCES delivery_cash_adjustments(tenant_id,id),UNIQUE(tenant_id,adjustment_id)
);
CREATE FUNCTION cod_adjustment_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM delivery_cash_adjustments WHERE id=NEW.adjustment_id AND tenant_id=NEW.tenant_id AND requested_by=NEW.decided_by) THEN RAISE EXCEPTION 'COD cash adjustment requires a second person';END IF;
 IF NEW.approved AND NOT EXISTS(SELECT 1 FROM delivery_cash_adjustments a JOIN documents d ON d.id=a.document_id AND d.tenant_id=a.tenant_id AND d.delivery_parcel_id=a.parcel_id WHERE a.id=NEW.adjustment_id AND a.tenant_id=NEW.tenant_id AND d.status='issued' AND NOT d.hold) THEN RAISE EXCEPTION 'COD adjustment requires current issued parcel evidence';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cod_adjustment_decision_guard BEFORE INSERT ON delivery_cash_adjustment_decisions FOR EACH ROW EXECUTE FUNCTION cod_adjustment_decision_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['delivery_cash_adjustments','delivery_cash_adjustment_decisions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()',t);
END LOOP;END $$;
CREATE INDEX cod_adjustment_parcel ON delivery_cash_adjustments(tenant_id,parcel_id,created_at);
GRANT SELECT,INSERT ON delivery_cash_adjustments,delivery_cash_adjustment_decisions TO lbt_app;
