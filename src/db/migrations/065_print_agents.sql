-- Network label printing from a cloud installation: a small agent on the site LAN polls for queued jobs and writes them to the printers' raw TCP port (9100).
-- The server never reaches into the LAN. Job payloads are label text and barcodes only.
CREATE TABLE print_agents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), label text NOT NULL, token_hash text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')), last_seen timestamptz, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id), UNIQUE (tenant_id, label)
);
CREATE TABLE print_printers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), agent_id uuid NOT NULL, name text NOT NULL,
 host text NOT NULL CHECK (host ~ '^[A-Za-z0-9.-]{1,120}$'), port int NOT NULL DEFAULT 9100 CHECK (port BETWEEN 1 AND 65535),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, agent_id) REFERENCES print_agents(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);
CREATE TABLE print_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), printer_id uuid NOT NULL, kind text NOT NULL, payload text NOT NULL CHECK (length(payload) <= 200000),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','done','failed')), attempts int NOT NULL DEFAULT 0, leased_until timestamptz, error text,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), done_at timestamptz,
 FOREIGN KEY (tenant_id, printer_id) REFERENCES print_printers(tenant_id, id)
);
CREATE INDEX print_jobs_open ON print_jobs (tenant_id, printer_id, created_at) WHERE status IN ('queued','leased');
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['print_agents','print_printers','print_jobs'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON print_agents, print_printers, print_jobs TO lbt_app;
