CREATE TABLE fulfil_storage_contracts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),reference uuid NOT NULL,
 party_id uuid NOT NULL,entity_id uuid NOT NULL,document_id uuid NOT NULL,valid_from date NOT NULL,valid_until date NOT NULL CHECK(valid_until>=valid_from),
 basis text NOT NULL CHECK(basis='closing_occupied_location'),unit_minor bigint NOT NULL CHECK(unit_minor BETWEEN 0 AND 100000000),
 currency text NOT NULL CHECK(currency='AED'),tax_code text NOT NULL CHECK(tax_code IN ('SR5','ZR0','EX0','OOS')),
 scope text NOT NULL,reviewer text NOT NULL,approved_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,reference),
 FOREIGN KEY(tenant_id,party_id) REFERENCES parties(tenant_id,id),FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id)
);
CREATE TABLE fulfil_storage_days (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),contract_id uuid NOT NULL,party_id uuid NOT NULL,day date NOT NULL,
 cutoff_at timestamptz NOT NULL,occupied_locations int NOT NULL CHECK(occupied_locations>=0),occupancy jsonb NOT NULL,
 charge_id uuid,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES fulfil_storage_contracts(tenant_id,id),FOREIGN KEY(tenant_id,party_id) REFERENCES parties(tenant_id,id),
 UNIQUE(tenant_id,party_id,day),UNIQUE(tenant_id,charge_id)
);
ALTER TABLE fulfil_charges ADD COLUMN entity_id uuid;
ALTER TABLE fulfil_charges ADD CONSTRAINT fulfil_charge_entity FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id);
ALTER TABLE fulfil_charges ADD CONSTRAINT fulfil_charge_tenant_id UNIQUE(tenant_id,id);
ALTER TABLE fulfil_storage_days ADD CONSTRAINT fulfil_storage_charge FOREIGN KEY(tenant_id,charge_id) REFERENCES fulfil_charges(tenant_id,id);
CREATE TRIGGER fulfil_storage_contract_immutable BEFORE UPDATE OR DELETE ON fulfil_storage_contracts FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER fulfil_storage_day_immutable BEFORE UPDATE OR DELETE ON fulfil_storage_days FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE FUNCTION fulfil_charge_financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.party_id,NEW.code,NEW.description,NEW.qty,NEW.unit_minor,NEW.tax_code,NEW.source_key,NEW.order_id,NEW.entity_id,NEW.created_at) IS DISTINCT FROM
 (OLD.id,OLD.tenant_id,OLD.party_id,OLD.code,OLD.description,OLD.qty,OLD.unit_minor,OLD.tax_code,OLD.source_key,OLD.order_id,OLD.entity_id,OLD.created_at)
 THEN RAISE EXCEPTION 'fulfilment charge financial evidence is immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER fulfil_charge_financial_guard BEFORE UPDATE ON fulfil_charges FOR EACH ROW EXECUTE FUNCTION fulfil_charge_financial_immutable();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['fulfil_storage_contracts','fulfil_storage_days'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP;END $$;
GRANT SELECT,INSERT ON fulfil_storage_contracts,fulfil_storage_days TO lbt_app;
