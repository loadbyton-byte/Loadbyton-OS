-- Order pulls: a merchant's marketplace or storefront that exposes a REST list of orders (Noon, Amazon through a gateway, Magento, a custom shop) is polled and mapped into fulfilment orders.
-- Orders are idempotent on the marketplace order reference; cancellations cancel an order only while it has not shipped.
CREATE TABLE order_pulls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), party_id uuid NOT NULL, label text NOT NULL, url text NOT NULL,
 auth_scheme text NOT NULL CHECK (auth_scheme IN ('bearer','header','oauth2_client')), auth_header text, secret_sealed text NOT NULL, token_url text, token_scope text,
 items_path text NOT NULL DEFAULT '', since_param text NOT NULL DEFAULT 'since', response_format text NOT NULL DEFAULT 'json' CHECK (response_format IN ('json','csv')),
 page_mode text NOT NULL DEFAULT 'none' CHECK (page_mode IN ('none','cursor','page','link')), page_param text, next_path text, max_pages int NOT NULL DEFAULT 10 CHECK (max_pages BETWEEN 1 AND 50),
 field_map jsonb NOT NULL, channel text NOT NULL, cursor timestamptz, active boolean NOT NULL DEFAULT true, last_pull_at timestamptz, last_status text, last_error text, last_added int NOT NULL DEFAULT 0,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, label)
);
CREATE TABLE order_pull_events (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), pull_id uuid NOT NULL, order_ref text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('ingested','cancelled','rejected')),
 reason text, order_id uuid, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (tenant_id, pull_id) REFERENCES order_pulls(tenant_id, id)
);
CREATE INDEX order_pull_events_pull ON order_pull_events (tenant_id, pull_id, id DESC);
CREATE TRIGGER order_pull_events_immutable BEFORE UPDATE OR DELETE ON order_pull_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['order_pulls','order_pull_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON order_pulls TO lbt_app;
GRANT SELECT,INSERT ON order_pull_events TO lbt_app;
GRANT USAGE,SELECT ON SEQUENCE order_pull_events_id_seq TO lbt_app;
