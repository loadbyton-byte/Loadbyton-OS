CREATE TABLE specialist_reviews (
 tenant_id uuid NOT NULL REFERENCES tenants(id),sector text NOT NULL,reviewer text NOT NULL,document_id uuid NOT NULL,
 valid_until date NOT NULL,approved_by uuid NOT NULL REFERENCES users(id),approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,sector),FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id)
);
CREATE TABLE specialist_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),entity_id uuid NOT NULL,party_id uuid NOT NULL,
 sector text NOT NULL,no text NOT NULL,external_ref text NOT NULL,subject_ref text NOT NULL,attributes jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','active','hold','completed','closed','cancelled')),
 fee_minor bigint NOT NULL CHECK(fee_minor>=0),tax_code text NOT NULL,invoice_id uuid,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,party_id) REFERENCES parties(tenant_id,id),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,no),UNIQUE(tenant_id,sector,party_id,external_ref)
);
CREATE UNIQUE INDEX specialist_active_asset ON specialist_cases(tenant_id,sector,subject_ref) WHERE sector IN ('automotive-logistics','container-depot') AND status NOT IN ('closed','cancelled');
CREATE TABLE specialist_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),case_id uuid NOT NULL,
 kind text NOT NULL,attributes jsonb NOT NULL,note text NOT NULL,document_id uuid,client_ref text NOT NULL,
 recorded_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,case_id) REFERENCES specialist_cases(tenant_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,case_id,client_ref)
);
CREATE TRIGGER specialist_event_immutable BEFORE UPDATE OR DELETE ON specialist_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE invoices ADD COLUMN specialist_case_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY(tenant_id,specialist_case_id) REFERENCES specialist_cases(tenant_id,id);
CREATE FUNCTION specialist_contract_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.entity_id,NEW.party_id,NEW.sector,NEW.no,NEW.external_ref,NEW.subject_ref,NEW.attributes,NEW.fee_minor,NEW.tax_code,NEW.created_by)
 IS DISTINCT FROM (OLD.tenant_id,OLD.entity_id,OLD.party_id,OLD.sector,OLD.no,OLD.external_ref,OLD.subject_ref,OLD.attributes,OLD.fee_minor,OLD.tax_code,OLD.created_by)
 THEN RAISE EXCEPTION 'specialist case contract is immutable'; END IF;RETURN NEW;END $$;
CREATE TRIGGER specialist_contract_immutable BEFORE UPDATE ON specialist_cases FOR EACH ROW EXECUTE FUNCTION specialist_contract_immutable();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['specialist_reviews','specialist_cases','specialist_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON specialist_reviews,specialist_cases TO lbt_app;
GRANT SELECT,INSERT ON specialist_events TO lbt_app;
CREATE INDEX specialist_queue ON specialist_cases(tenant_id,sector,status,created_at);
