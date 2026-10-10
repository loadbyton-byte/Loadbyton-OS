-- LOAD|BY|TON Transport: vehicles, drivers, compliance, orders, trips, legs, offline-safe events, expenses.

ALTER TABLE memberships ADD COLUMN driver_id uuid;
ALTER TABLE invitations ADD COLUMN driver_id uuid;
ALTER TABLE entities ADD COLUMN capture_location boolean NOT NULL DEFAULT false;   -- POD location only when policy allows

CREATE TABLE vehicles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  reg_no      text NOT NULL,
  kind        text NOT NULL DEFAULT 'truck',
  capacity_kg numeric(12,1) NOT NULL CHECK (capacity_kg > 0),
  capacity_cbm numeric(12,2),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reg_no)
);

CREATE TABLE drivers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  phone      text,
  licence_no text,
  user_id    uuid REFERENCES users(id),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE compliance_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  subject_type text NOT NULL CHECK (subject_type IN ('vehicle','driver')),
  subject_id   uuid NOT NULL,
  kind         text NOT NULL,                         -- registration, insurance, inspection, licence, medical, permit
  blocking     boolean NOT NULL DEFAULT true,          -- an expired blocking item prevents assignment
  expires_on   date NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  vehicle_id uuid NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL CHECK (ends_at > starts_at),
  reason     text NOT NULL,
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles(tenant_id, id)
);

CREATE TABLE trips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  vehicle_id    uuid,
  driver_id     uuid,
  subcontractor_id uuid,                              -- supplier party that performs the trip
  subcontract_estimate_minor bigint NOT NULL DEFAULT 0,
  subcontract_actual_minor   bigint,
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','dispatched','in_progress','completed','cancelled')),
  planned_start timestamptz NOT NULL,
  planned_end   timestamptz NOT NULL CHECK (planned_end > planned_start),
  est_km        numeric(10,1),
  actual_km     numeric(10,1),
  notes         text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles(tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id),
  FOREIGN KEY (tenant_id, subcontractor_id) REFERENCES parties(tenant_id, id),
  CHECK ((subcontractor_id IS NULL AND vehicle_id IS NOT NULL AND driver_id IS NOT NULL) OR (subcontractor_id IS NOT NULL AND vehicle_id IS NULL AND driver_id IS NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE transport_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  no          text NOT NULL,
  party_id    uuid NOT NULL,
  pickup_address   text NOT NULL,
  delivery_address text NOT NULL,
  cargo_desc  text,
  weight_kg   numeric(12,1) NOT NULL DEFAULT 0,
  volume_cbm  numeric(12,2) NOT NULL DEFAULT 0,
  ready_at    timestamptz,
  deliver_by  timestamptz,
  detention_rate_minor bigint NOT NULL DEFAULT 0,     -- per hour beyond free time, 0 = not billed
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','planned','in_progress','delivered','cancelled')),
  trip_id     uuid,
  financial_status text NOT NULL DEFAULT 'open' CHECK (financial_status IN ('open','invoiced','collected')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES trips(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE transport_order_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  order_id    uuid NOT NULL,
  description text NOT NULL,
  qty         numeric(12,3) NOT NULL DEFAULT 1,
  unit_minor  bigint NOT NULL,
  tax_code    text NOT NULL DEFAULT 'SR5',
  source_leg_id uuid UNIQUE,                          -- a detention charge can be created once per leg
  invoice_id  uuid,
  FOREIGN KEY (tenant_id, order_id) REFERENCES transport_orders(tenant_id, id)
);

CREATE TABLE trip_legs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  trip_id     uuid NOT NULL,
  order_id    uuid NOT NULL,
  seq         int NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('pickup','delivery')),
  address     text NOT NULL,
  planned_at  timestamptz,
  free_minutes int NOT NULL DEFAULT 120,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','arrived','done','failed')),
  arrived_at  timestamptz,
  departed_at timestamptz,
  detention_minutes int,
  pod_name    text,                                    -- who signed / received
  pod_at      timestamptz,
  pod_lat     numeric(9,6),
  pod_lng     numeric(9,6),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES trips(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES transport_orders(tenant_id, id),
  UNIQUE (tenant_id, id)
);

-- Driver events are keyed by a client-generated id so a replay/double sync can never create a second effect.
CREATE TABLE trip_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  trip_id         uuid NOT NULL,
  leg_id          uuid,
  client_event_id text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('arrive','depart','pod','exception','expense','note')),
  device_time     timestamptz NOT NULL,                 -- as reported by the device (kept verbatim)
  effective_time  timestamptz NOT NULL,                 -- after sanity clamp
  server_time     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL DEFAULT '{}',
  applied         boolean NOT NULL,
  resolution      text,                                 -- why an event was stored but not applied / adjusted
  actor_user_id   uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES trips(tenant_id, id),
  UNIQUE (tenant_id, client_event_id)
);
CREATE TRIGGER trip_events_immutable BEFORE UPDATE OR DELETE ON trip_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE trip_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  trip_id         uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('fuel','toll','parking','other')),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  note            text,
  client_event_id text,
  status          text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','approved','rejected')),
  recorded_by     uuid REFERENCES users(id),
  decided_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, trip_id) REFERENCES trips(tenant_id, id),
  UNIQUE (tenant_id, client_event_id)
);

ALTER TABLE invoices ADD COLUMN transport_order_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY (tenant_id, transport_order_id) REFERENCES transport_orders(tenant_id, id);
ALTER TABLE documents ADD COLUMN trip_id uuid;
ALTER TABLE documents ADD COLUMN transport_order_id uuid;
ALTER TABLE documents ADD FOREIGN KEY (tenant_id, trip_id) REFERENCES trips(tenant_id, id);
ALTER TABLE documents ADD FOREIGN KEY (tenant_id, transport_order_id) REFERENCES transport_orders(tenant_id, id);

ALTER TABLE memberships ADD FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id);
ALTER TABLE invitations ADD FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicles','drivers','compliance_items','maintenance_blocks','trips','transport_orders',
    'transport_order_charges','trip_legs','trip_events','trip_expenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON vehicles, drivers, compliance_items, maintenance_blocks, trips, transport_orders,
  transport_order_charges, trip_legs, trip_expenses TO lbt_app;
GRANT SELECT, INSERT ON trip_events TO lbt_app;

-- drivers' names for dispatch lists without exposing the users table
CREATE OR REPLACE VIEW team_members AS
  SELECT m.tenant_id, m.user_id, u.email, u.name, m.roles, m.party_id, m.active, m.driver_id
  FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
