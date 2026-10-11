CREATE TABLE setup_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
 scope text NOT NULL, status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','scheduled','working','review','accepted','cancelled')),
 technician_id uuid REFERENCES users(id),appointment_at timestamptz,access_expires_at timestamptz,
 evidence text,unresolved text,accepted_by uuid REFERENCES users(id),accepted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
ALTER TABLE setup_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON setup_orders USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,UPDATE ON setup_orders TO lbt_app;
CREATE TABLE api_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),user_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL,token_hash text NOT NULL UNIQUE,scopes text[] NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE api_mutations (
 tenant_id uuid NOT NULL REFERENCES tenants(id),key_id uuid NOT NULL,path text NOT NULL,idempotency_key text NOT NULL,
 payload_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,key_id,path,idempotency_key),
 FOREIGN KEY(tenant_id,key_id) REFERENCES api_keys(tenant_id,id)
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_mutations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON api_mutations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON api_keys TO lbt_app;
GRANT SELECT,INSERT ON api_mutations TO lbt_app;
CREATE TRIGGER api_mutations_immutable BEFORE UPDATE OR DELETE ON api_mutations FOR EACH ROW EXECUTE FUNCTION forbid_change();
