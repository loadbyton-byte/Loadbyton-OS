-- Brochure model: a client registers a free or paid build request after seeing the demo; we customise and deliver it within the promised window.
-- The client runs the delivered system on their own backend, so nothing here meters or bills usage.
CREATE TABLE service_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), requested_by uuid NOT NULL REFERENCES users(id),
 category text NOT NULL CHECK (category IN ('free','paid')),
 sectors text[] NOT NULL DEFAULT '{}', title text NOT NULL CHECK (length(title) BETWEEN 3 AND 160),
 requirements text NOT NULL CHECK (length(requirements) BETWEEN 10 AND 6000),
 backend_notes text, demo_reviewed boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','in_build','ready','delivered','cancelled')),
 due_at timestamptz NOT NULL, delivered_at timestamptz,
 quote_note text, delivery_url text, delivery_notes text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 CONSTRAINT delivered_has_time CHECK ((status='delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX service_requests_open ON service_requests(due_at) WHERE status IN ('received','in_build','ready');
CREATE TABLE service_request_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, request_id uuid NOT NULL,
 status text NOT NULL, note text, actor_kind text NOT NULL CHECK (actor_kind IN ('client','staff','system')), actor_user_id uuid REFERENCES users(id),
 at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,request_id) REFERENCES service_requests(tenant_id,id)
);
ALTER TABLE service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_requests USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON service_request_events USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- Clients may create and read their requests and cancel their own; every other change is made by staff through the system role.
GRANT SELECT,INSERT,UPDATE ON service_requests TO lbt_app;
GRANT SELECT,INSERT ON service_request_events TO lbt_app;
CREATE TRIGGER service_request_events_immutable BEFORE UPDATE OR DELETE ON service_request_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
