-- Storefront connectors: signed Shopify / WooCommerce order webhooks land as immutable event records; valid ones become fulfilment orders for one merchant.
CREATE TABLE storefront_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), party_id uuid NOT NULL, platform text NOT NULL CHECK (platform IN ('shopify','woocommerce')),
 label text NOT NULL, token_hash text NOT NULL UNIQUE, secret_enc text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
 last_seen timestamptz, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, label)
);
CREATE TABLE storefront_events (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), connection_id uuid NOT NULL, event_ref text NOT NULL, topic text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('ingested','rejected','cancelled')), reason text, order_id uuid, attempt int NOT NULL DEFAULT 1 CHECK (attempt >= 1),
 recoverable boolean NOT NULL DEFAULT false, received_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, connection_id) REFERENCES storefront_connections(tenant_id, id), UNIQUE (connection_id, event_ref, attempt),
 CHECK (outcome = 'rejected' OR NOT recoverable), CHECK (outcome = 'rejected' OR order_id IS NOT NULL), CHECK (outcome <> 'rejected' OR reason IS NOT NULL)
);
CREATE INDEX storefront_events_conn ON storefront_events (tenant_id, connection_id, received_at DESC);
CREATE TRIGGER storefront_events_immutable BEFORE UPDATE OR DELETE ON storefront_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['storefront_connections','storefront_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON storefront_connections TO lbt_app;
GRANT SELECT,INSERT ON storefront_events TO lbt_app;
GRANT USAGE,SELECT ON SEQUENCE storefront_events_id_seq TO lbt_app;
