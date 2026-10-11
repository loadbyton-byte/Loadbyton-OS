-- Live statement feeds: a workspace's own bank / card-settlement / fuel-card / Salik API, pulled on a schedule into the same importers the CSV uploads use.
-- Credentials belong to the workspace (sealed here), never to the installation. Each provider transaction id is remembered so an overlapping pull adds nothing.
CREATE TABLE feed_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 kind text NOT NULL CHECK (kind IN ('bank','fuel','salik')), label text NOT NULL, url text NOT NULL,
 auth_scheme text NOT NULL DEFAULT 'bearer' CHECK (auth_scheme IN ('bearer','header')), auth_header text, secret_sealed text NOT NULL,
 items_path text NOT NULL DEFAULT '', since_param text NOT NULL DEFAULT 'since', field_map jsonb NOT NULL DEFAULT '{}',
 cursor date, active boolean NOT NULL DEFAULT true, last_pull_at timestamptz, last_status text, last_error text, last_added int NOT NULL DEFAULT 0,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, kind, label)
);
CREATE TABLE feed_seen (
 tenant_id uuid NOT NULL REFERENCES tenants(id), connection_id uuid NOT NULL, external_id text NOT NULL, seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (connection_id, external_id), FOREIGN KEY (tenant_id, connection_id) REFERENCES feed_connections(tenant_id, id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['feed_connections','feed_seen'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON feed_connections TO lbt_app;
GRANT SELECT,INSERT ON feed_seen TO lbt_app;
