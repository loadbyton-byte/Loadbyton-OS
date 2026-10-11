-- Customs cases record an evidence-based handover; they do not file declarations with an authority.
ALTER TABLE documents ADD CONSTRAINT documents_tenant_id_id_key UNIQUE (tenant_id,id);
CREATE TABLE customs_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 party_id uuid NOT NULL, no text NOT NULL, external_ref text NOT NULL,
 declaration_type text NOT NULL CHECK (declaration_type IN ('import','export','transit')),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','handed_over','inspection','cleared','cancelled')),
 official_ref text, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,party_id) REFERENCES parties(tenant_id,id),
 UNIQUE (tenant_id,id), UNIQUE (tenant_id,no), UNIQUE (tenant_id,party_id,external_ref)
);
CREATE TABLE customs_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), case_id uuid NOT NULL,
 document_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('commercial_invoice','packing_list','transport_document','permit','clearance','inspection')),
 recorded_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,case_id) REFERENCES customs_cases(tenant_id,id),
 FOREIGN KEY (tenant_id,document_id) REFERENCES documents(tenant_id,id),
 UNIQUE (tenant_id,case_id,document_id,kind)
);
CREATE TABLE customs_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), case_id uuid NOT NULL,
 status text NOT NULL, reason text NOT NULL, recorded_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,case_id) REFERENCES customs_cases(tenant_id,id)
);
CREATE TABLE customs_deposit_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), case_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('received','refunded')), amount_minor bigint NOT NULL CHECK (amount_minor>0), reference text NOT NULL,
 recorded_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,case_id) REFERENCES customs_cases(tenant_id,id), UNIQUE (tenant_id,reference)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customs_cases','customs_evidence','customs_events','customs_deposit_entries'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  IF t<>'customs_cases' THEN EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()',t); END IF;
 END LOOP;
END $$;
CREATE INDEX customs_work_queue ON customs_cases(tenant_id,status,created_at);
GRANT SELECT,INSERT,UPDATE ON customs_cases TO lbt_app;
GRANT SELECT,INSERT ON customs_evidence,customs_events,customs_deposit_entries TO lbt_app;
