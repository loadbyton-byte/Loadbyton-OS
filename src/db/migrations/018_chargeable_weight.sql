CREATE TABLE weight_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 provider text NOT NULL,mode text NOT NULL CHECK(mode IN ('air','road','ocean')),
 formula text NOT NULL CHECK(formula IN ('volumetric_kg','weight_measure')),
 coefficient numeric(18,6) NOT NULL CHECK(coefficient>0),increment numeric(18,6) NOT NULL CHECK(increment>0),
 minimum numeric(18,6) NOT NULL CHECK(minimum>=0),valid_from date NOT NULL,valid_until date NOT NULL CHECK(valid_until>=valid_from),
 document_id uuid NOT NULL,reviewer text NOT NULL,scope text NOT NULL,approved_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),UNIQUE(tenant_id,id),
 CHECK((formula='volumetric_kg' AND mode IN ('air','road')) OR (formula='weight_measure' AND mode='ocean'))
);
CREATE TABLE weight_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),enquiry_id uuid NOT NULL,rule_id uuid NOT NULL,
 reference uuid NOT NULL,gross_kg numeric(18,6) NOT NULL CHECK(gross_kg>0),volume_cbm numeric(18,6) NOT NULL CHECK(volume_cbm>0),
 chargeable numeric(18,6) NOT NULL CHECK(chargeable>0),unit text NOT NULL CHECK(unit IN ('kg','revenue_tonne')),
 explanation jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,enquiry_id) REFERENCES enquiries(tenant_id,id),FOREIGN KEY(tenant_id,rule_id) REFERENCES weight_rules(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,reference)
);
CREATE FUNCTION weight_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'weight rule and assessment evidence is immutable; append a new version';END $$;
CREATE TRIGGER immutable_rule BEFORE UPDATE OR DELETE ON weight_rules FOR EACH ROW EXECUTE FUNCTION weight_evidence_immutable();
CREATE TRIGGER immutable_assessment BEFORE UPDATE OR DELETE ON weight_assessments FOR EACH ROW EXECUTE FUNCTION weight_evidence_immutable();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['weight_rules','weight_assessments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP;END $$;
GRANT SELECT,INSERT ON weight_rules,weight_assessments TO lbt_app;
