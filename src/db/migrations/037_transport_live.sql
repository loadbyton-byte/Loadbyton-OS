-- Transport: consent-based GPS positions, planned leg coordinates for route optimisation, and fuel-card / Salik statement feeds.
ALTER TABLE trip_legs ADD COLUMN lat numeric(9,6) CHECK (lat IS NULL OR lat BETWEEN -90 AND 90);
ALTER TABLE trip_legs ADD COLUMN lng numeric(9,6) CHECK (lng IS NULL OR lng BETWEEN -180 AND 180);
ALTER TABLE trip_legs ADD CONSTRAINT trip_legs_coords_pair CHECK ((lat IS NULL) = (lng IS NULL));

CREATE TABLE driver_location_consent (
 tenant_id uuid NOT NULL REFERENCES tenants(id), driver_id uuid NOT NULL, granted_by uuid NOT NULL REFERENCES users(id),
 granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 PRIMARY KEY (tenant_id, driver_id), FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id)
);
CREATE TABLE trip_positions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), trip_id uuid NOT NULL, driver_id uuid NOT NULL,
 lat numeric(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90), lng numeric(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
 accuracy_m int CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 100000), speed_kmh numeric(6,1) CHECK (speed_kmh IS NULL OR speed_kmh BETWEEN 0 AND 400),
 device_time timestamptz NOT NULL, effective_time timestamptz NOT NULL, server_time timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, trip_id) REFERENCES trips(tenant_id, id), FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id),
 UNIQUE (tenant_id, trip_id, device_time)
);
CREATE INDEX trip_positions_latest ON trip_positions (tenant_id, trip_id, effective_time DESC);
CREATE INDEX trip_positions_age ON trip_positions (tenant_id, effective_time);

CREATE TABLE transport_feed_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), kind text NOT NULL CHECK (kind IN ('fuel','salik')),
 label text NOT NULL, source_hash text NOT NULL, line_count int NOT NULL CHECK (line_count >= 0), duplicate_count int NOT NULL DEFAULT 0,
 imported_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id), UNIQUE (tenant_id, source_hash)
);
CREATE TABLE transport_feed_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), import_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('fuel','salik')),
 reference text NOT NULL, occurred_at timestamptz NOT NULL, plate text NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor > 0), quantity numeric(10,2),
 detail text NOT NULL DEFAULT '', vehicle_id uuid, trip_id uuid, status text NOT NULL CHECK (status IN ('matched','vehicle_only','unmatched','posted','ignored')),
 expense_id uuid, decided_by uuid REFERENCES users(id), note text,
 FOREIGN KEY (tenant_id, import_id) REFERENCES transport_feed_imports(tenant_id, id), FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles(tenant_id, id),
 FOREIGN KEY (tenant_id, trip_id) REFERENCES trips(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, kind, reference)
);
CREATE FUNCTION transport_feed_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.tenant_id,NEW.import_id,NEW.kind,NEW.reference,NEW.occurred_at,NEW.plate,NEW.amount_minor,NEW.quantity,NEW.detail) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.import_id,OLD.kind,OLD.reference,OLD.occurred_at,OLD.plate,OLD.amount_minor,OLD.quantity,OLD.detail)
 THEN RAISE EXCEPTION 'imported provider statement lines are immutable; only their matching state changes'; END IF; RETURN NEW; END $$;
CREATE TRIGGER transport_feed_line_guard BEFORE UPDATE OR DELETE ON transport_feed_lines FOR EACH ROW EXECUTE FUNCTION transport_feed_line_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['driver_location_consent','trip_positions','transport_feed_imports','transport_feed_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON driver_location_consent, transport_feed_lines TO lbt_app;
GRANT SELECT,INSERT,DELETE ON trip_positions TO lbt_app;
GRANT SELECT,INSERT,UPDATE ON transport_feed_imports TO lbt_app;

-- GPS positions are personal data: they join the retention-policy subjects.
ALTER TABLE privacy_retention_policies DROP CONSTRAINT privacy_retention_policies_subject_check;
ALTER TABLE privacy_retention_policies ADD CONSTRAINT privacy_retention_policies_subject_check CHECK (subject IN ('fulfil_recipient','delivery_consignee','driver_positions'));
