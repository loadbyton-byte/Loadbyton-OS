ALTER TABLE fulfil_storage_days ALTER COLUMN created_by DROP NOT NULL;
CREATE TABLE fulfil_storage_automation (
 tenant_id uuid NOT NULL REFERENCES tenants(id),contract_id uuid PRIMARY KEY,enabled boolean NOT NULL DEFAULT false,
 approved_by uuid NOT NULL REFERENCES users(id),reason text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES fulfil_storage_contracts(tenant_id,id)
);
ALTER TABLE fulfil_storage_automation ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fulfil_storage_automation USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON fulfil_storage_automation TO lbt_app;
