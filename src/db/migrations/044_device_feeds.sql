-- Specialist device feeds: signed temperature-logger pushes (and logger CSV downloads) land as raw, immutable readings; valid ones become cold-chain case events.
CREATE TABLE specialist_devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), label text NOT NULL, serial text NOT NULL,
 interval_minutes int NOT NULL CHECK (interval_minutes BETWEEN 1 AND 1440), token_hash text NOT NULL UNIQUE, secret_enc text NOT NULL,
 case_id uuid, bound_at timestamptz, unbound_at timestamptz, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
 last_seen timestamptz, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, case_id) REFERENCES specialist_cases(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, serial),
 CHECK ((case_id IS NULL) = (bound_at IS NULL))
);
CREATE TABLE device_readings (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), device_id uuid NOT NULL, reading_ref text NOT NULL, observed_at timestamptz NOT NULL,
 celsius numeric(6,2) NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), outcome text NOT NULL CHECK (outcome IN ('ingested','rejected')), reason text,
 case_id uuid, event_id uuid, source text NOT NULL DEFAULT 'push' CHECK (source IN ('push','csv')),
 attempt int NOT NULL DEFAULT 1 CHECK (attempt >= 1), recoverable boolean NOT NULL DEFAULT false,
 FOREIGN KEY (tenant_id, device_id) REFERENCES specialist_devices(tenant_id, id), UNIQUE (device_id, reading_ref, attempt), CHECK (outcome = 'rejected' OR NOT recoverable),
 CHECK ((outcome = 'ingested' AND event_id IS NOT NULL AND case_id IS NOT NULL) OR (outcome = 'rejected' AND reason IS NOT NULL))
);
CREATE INDEX device_readings_case ON device_readings (tenant_id, case_id, observed_at);
CREATE TRIGGER device_readings_immutable BEFORE UPDATE OR DELETE ON device_readings FOR EACH ROW EXECUTE FUNCTION forbid_change();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['specialist_devices','device_readings'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON specialist_devices TO lbt_app;
GRANT SELECT,INSERT ON device_readings TO lbt_app;
GRANT USAGE,SELECT ON SEQUENCE device_readings_id_seq TO lbt_app;
