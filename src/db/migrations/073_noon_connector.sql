-- Noon "Fulfilled by Partner" connector. Noon's partner portal lets a seller act as their own integrator by giving it a webhook address and an API key; Noon's order payload is not
-- published where we could read it, so the connection carries a field map the operator builds from a captured sample, and an optional capture mode that keeps a few raw deliveries.
ALTER TABLE storefront_connections DROP CONSTRAINT IF EXISTS storefront_connections_platform_check;
ALTER TABLE storefront_connections ADD CONSTRAINT storefront_connections_platform_check CHECK (platform IN ('shopify','woocommerce','noon'));
ALTER TABLE storefront_connections ADD COLUMN field_map jsonb, ADD COLUMN order_path text, ADD COLUMN key_header text, ADD COLUMN capture boolean NOT NULL DEFAULT false;
ALTER TABLE storefront_connections ADD CONSTRAINT storefront_noon_mapped CHECK (platform <> 'noon' OR (field_map IS NOT NULL AND key_header IS NOT NULL));
CREATE TABLE storefront_samples (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), connection_id uuid NOT NULL, body text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, connection_id) REFERENCES storefront_connections(tenant_id, id)
);
CREATE INDEX storefront_samples_conn ON storefront_samples (tenant_id, connection_id, id DESC);
ALTER TABLE storefront_samples ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON storefront_samples USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT, DELETE ON storefront_samples TO lbt_app;
GRANT USAGE, SELECT ON SEQUENCE storefront_samples_id_seq TO lbt_app;
