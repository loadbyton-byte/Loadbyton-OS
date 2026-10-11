CREATE TABLE document_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),reference uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('commercial_invoice','packing_list','booking_confirmation','transport_document','delivery_order','shipment_instructions')),
 version int NOT NULL CHECK(version>0),title text NOT NULL,footer text NOT NULL,fields jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,reference),UNIQUE(tenant_id,kind,version)
);
CREATE TABLE generated_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),reference uuid NOT NULL,job_id uuid NOT NULL,template_id uuid NOT NULL,source_document_id uuid NOT NULL,
 kind text NOT NULL,version int NOT NULL CHECK(version>0),status text NOT NULL DEFAULT 'draft' CHECK(status='draft'),
 fields jsonb NOT NULL,source_snapshot jsonb NOT NULL,source_hash text NOT NULL,size_bytes int NOT NULL CHECK(size_bytes BETWEEN 1 AND 65536),created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),FOREIGN KEY(tenant_id,template_id) REFERENCES document_templates(tenant_id,id),FOREIGN KEY(tenant_id,source_document_id) REFERENCES documents(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,reference),UNIQUE(tenant_id,job_id,kind,version)
);
CREATE TRIGGER document_template_immutable BEFORE UPDATE OR DELETE ON document_templates FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER generated_document_immutable BEFORE UPDATE OR DELETE ON generated_documents FOR EACH ROW EXECUTE FUNCTION forbid_change();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['document_templates','generated_documents'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP;END $$;
GRANT SELECT,INSERT ON document_templates,generated_documents TO lbt_app;
