-- UAE readiness: party / entity identity and address data, Arabic names, e-invoice payloads and their submission state.
ALTER TABLE entities ADD COLUMN legal_name_ar text;
ALTER TABLE entities ADD COLUMN address_line text;
ALTER TABLE entities ADD COLUMN city text;
ALTER TABLE entities ADD COLUMN emirate text;
ALTER TABLE entities ADD COLUMN country text NOT NULL DEFAULT 'AE' CHECK (country ~ '^[A-Z]{2}$');
ALTER TABLE entities ADD COLUMN einvoice_scheme text;
ALTER TABLE entities ADD COLUMN einvoice_endpoint text;
ALTER TABLE parties ADD COLUMN name_ar text;
ALTER TABLE parties ADD COLUMN address_line text;
ALTER TABLE parties ADD COLUMN city text;
ALTER TABLE parties ADD COLUMN emirate text;
ALTER TABLE parties ADD COLUMN country text NOT NULL DEFAULT 'AE' CHECK (country ~ '^[A-Z]{2}$');
ALTER TABLE parties ADD COLUMN einvoice_scheme text;
ALTER TABLE parties ADD COLUMN einvoice_endpoint text;

CREATE TABLE einvoice_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','sandbox','live')), provider text,
 customization_id text, profile_id text, updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (mode <> 'live' OR provider IS NOT NULL)
);
CREATE TABLE einvoice_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), kind text NOT NULL CHECK (kind IN ('invoice','credit_note')), invoice_id uuid, credit_note_id uuid,
 number text NOT NULL, payload_xml text NOT NULL, payload_sha256 text NOT NULL, format_label text NOT NULL, issues jsonb NOT NULL DEFAULT '[]', submittable boolean NOT NULL,
 status text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated','submitted','accepted','rejected','error')), provider text, provider_ref text, provider_response jsonb,
 generated_by uuid NOT NULL REFERENCES users(id), generated_at timestamptz NOT NULL DEFAULT now(), submitted_by uuid REFERENCES users(id), submitted_at timestamptz, decided_at timestamptz,
 FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id), FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_notes(tenant_id, id),
 UNIQUE (tenant_id, id), CHECK ((kind = 'invoice' AND invoice_id IS NOT NULL AND credit_note_id IS NULL) OR (kind = 'credit_note' AND credit_note_id IS NOT NULL AND invoice_id IS NULL))
);
CREATE UNIQUE INDEX einvoice_one_per_invoice ON einvoice_documents (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL AND status IN ('generated','submitted','accepted');
CREATE UNIQUE INDEX einvoice_one_per_credit_note ON einvoice_documents (tenant_id, credit_note_id) WHERE credit_note_id IS NOT NULL AND status IN ('generated','submitted','accepted');
CREATE FUNCTION einvoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'e-invoice records are never deleted'; END IF;
 IF NEW.payload_xml IS DISTINCT FROM OLD.payload_xml OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256 OR NEW.number IS DISTINCT FROM OLD.number OR NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'a generated e-invoice payload is immutable'; END IF;
 IF OLD.status IN ('accepted') THEN RAISE EXCEPTION 'an accepted e-invoice is final'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER einvoice_guard BEFORE UPDATE OR DELETE ON einvoice_documents FOR EACH ROW EXECUTE FUNCTION einvoice_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['einvoice_settings','einvoice_documents'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON einvoice_settings, einvoice_documents TO lbt_app;
