-- Carrier tracking feeds: a carrier (or an aggregator) pushes signed status events for the tracking numbers entered at dispatch. Events are immutable and are joined to
-- shipments by (carrier, tracking number) when read, so an event that arrives before the dispatch is entered attaches itself afterwards.
CREATE TABLE carrier_feeds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), carrier text NOT NULL, label text NOT NULL,
 token_hash text NOT NULL UNIQUE, secret_enc text NOT NULL, signature_header text NOT NULL, signature_encoding text NOT NULL CHECK (signature_encoding IN ('hex','base64')),
 events_path text NOT NULL DEFAULT '', tracking_path text NOT NULL, status_path text NOT NULL, time_path text NOT NULL DEFAULT '', location_path text NOT NULL DEFAULT '',
 status_map jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')), last_seen timestamptz,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id), UNIQUE (tenant_id, label)
);
CREATE TABLE carrier_events (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), feed_id uuid NOT NULL, carrier text NOT NULL, tracking_no text NOT NULL, raw_status text NOT NULL,
 status text NOT NULL CHECK (status IN ('info_received','in_transit','out_for_delivery','delivered','exception','returned','other')), occurred_at timestamptz NOT NULL,
 location text, received_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, feed_id) REFERENCES carrier_feeds(tenant_id, id), UNIQUE (feed_id, tracking_no, raw_status, occurred_at)
);
CREATE INDEX carrier_events_track ON carrier_events (tenant_id, lower(carrier), tracking_no, occurred_at);
CREATE TRIGGER carrier_events_immutable BEFORE UPDATE OR DELETE ON carrier_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['carrier_feeds','carrier_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON carrier_feeds TO lbt_app;
GRANT SELECT,INSERT ON carrier_events TO lbt_app;
GRANT USAGE,SELECT ON SEQUENCE carrier_events_id_seq TO lbt_app;
