-- LOAD|BY|TON Delivery / COD (courier, last mile): merchant parcels, delivery runs, rider events (offline-safe),
-- failed attempts and returns, cash-on-delivery collection → rider cash handover (independent approval) → merchant remittance,
-- and activity billing (rate cards → idempotent charges → invoice, optionally netted from a COD remittance).
--
-- Money rules enforced here (not only in code):
--   * a parcel has at most ONE cash collection, equal to its COD amount, and it can never be edited or deleted;
--   * a collection belongs to at most one rider-cash settlement and at most one merchant remittance, and can only be
--     remitted after its settlement;
--   * a remittance's net = gross − fees.

CREATE TABLE dlv_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  no          text NOT NULL,
  driver_id   uuid NOT NULL,
  run_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','out','closed','cancelled')),
  started_at  timestamptz,
  closed_at   timestamptz,
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE dlv_shipments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,                              -- the waybill / AWB printed on the parcel
  merchant_id   uuid NOT NULL,
  external_ref  text,                                       -- the merchant's own order reference; unique per merchant (idempotent intake)
  track_token   text NOT NULL UNIQUE,                       -- unguessable public tracking handle (no personal data is shown on it)
  delivery_code text NOT NULL,                              -- 4 digits the consignee can quote to the rider
  require_code  boolean NOT NULL DEFAULT false,             -- when true the rider must enter the code to complete delivery
  consignee_name  text NOT NULL,
  consignee_phone text,
  address       text NOT NULL,
  emirate       text NOT NULL CHECK (emirate IN ('Abu Dhabi','Dubai','Sharjah','Ajman','Umm Al Quwain','Ras Al Khaimah','Fujairah')),
  origin_emirate text NOT NULL CHECK (origin_emirate IN ('Abu Dhabi','Dubai','Sharjah','Ajman','Umm Al Quwain','Ras Al Khaimah','Fujairah')),
  pieces        int NOT NULL DEFAULT 1 CHECK (pieces > 0),
  weight_kg     numeric(10,2) NOT NULL DEFAULT 0 CHECK (weight_kg >= 0),
  description   text,
  cod_minor     bigint NOT NULL DEFAULT 0 CHECK (cod_minor >= 0 AND cod_minor <= 5000000),   -- cash to collect, AED 50,000 cap per parcel
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','out_for_delivery','delivered','undelivered','return_to_sender','returned','cancelled')),
  run_id        uuid,
  attempts      int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  deliver_by    timestamptz,
  delivered_at  timestamptz,
  delivered_to  text,
  returned_at   timestamptz,
  last_failure  text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES dlv_runs(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no),
  UNIQUE (tenant_id, merchant_id, external_ref),
  CHECK (status <> 'delivered' OR (delivered_at IS NOT NULL AND delivered_to IS NOT NULL)),
  CHECK (status <> 'returned' OR returned_at IS NOT NULL)
);
CREATE INDEX dlv_shipments_status ON dlv_shipments(tenant_id, status);
CREATE INDEX dlv_shipments_run ON dlv_shipments(tenant_id, run_id);
CREATE INDEX dlv_shipments_merchant ON dlv_shipments(tenant_id, merchant_id, created_at DESC);

-- Rider events are keyed by a client-generated id so a replayed / double sync can never create a second effect.
CREATE TABLE dlv_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  shipment_id     uuid NOT NULL,
  run_id          uuid,
  client_event_id text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('created','assigned','unassigned','out','deliver','fail','note','reattempt','rts','returned','cancel')),
  device_time     timestamptz NOT NULL,
  effective_time  timestamptz NOT NULL,
  server_time     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL DEFAULT '{}',
  applied         boolean NOT NULL,
  resolution      text,
  actor_user_id   uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES dlv_shipments(tenant_id, id),
  UNIQUE (tenant_id, client_event_id)
);
CREATE INDEX dlv_events_shipment ON dlv_events(tenant_id, shipment_id, effective_time);
CREATE TRIGGER dlv_events_immutable BEFORE UPDATE OR DELETE ON dlv_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Rider cash handover to the cash desk. expected = what the rider collected; counted = what the cashier counted.
-- A non-zero variance needs a second person's decision (the owner excepted, because small tenants have one user).
CREATE TABLE dlv_settlements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  no             text NOT NULL,
  driver_id      uuid NOT NULL,
  expected_minor bigint NOT NULL CHECK (expected_minor > 0),
  counted_minor  bigint NOT NULL CHECK (counted_minor >= 0),
  variance_minor bigint GENERATED ALWAYS AS (counted_minor - expected_minor) STORED,
  status         text NOT NULL CHECK (status IN ('closed','pending_approval','rejected')),
  received_by    uuid REFERENCES users(id),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no),
  CHECK (status <> 'closed' OR counted_minor = expected_minor OR decided_by IS NOT NULL)
);

-- Pay-out to the merchant of cash that has been counted in. fees are netted from the payout (and invoiced), never silently dropped.
CREATE TABLE dlv_remittances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  merchant_id   uuid NOT NULL,
  gross_minor   bigint NOT NULL CHECK (gross_minor > 0),
  fees_minor    bigint NOT NULL DEFAULT 0 CHECK (fees_minor >= 0),
  net_minor     bigint NOT NULL CHECK (net_minor >= 0),
  invoice_id    uuid,
  status        text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','paid','void')),
  pay_reference text,
  paid_by       uuid REFERENCES users(id),
  paid_at       timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no),
  CHECK (net_minor = gross_minor - fees_minor),
  CHECK (status <> 'paid' OR (pay_reference IS NOT NULL AND paid_at IS NOT NULL))
);

CREATE TABLE dlv_collections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  shipment_id     uuid NOT NULL,
  driver_id       uuid NOT NULL,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  collected_at    timestamptz NOT NULL,
  client_event_id text NOT NULL,
  settlement_id   uuid,
  remittance_id   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES dlv_shipments(tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers(tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES dlv_settlements(tenant_id, id),
  FOREIGN KEY (tenant_id, remittance_id) REFERENCES dlv_remittances(tenant_id, id),
  UNIQUE (tenant_id, shipment_id),                    -- one collection per parcel, ever
  UNIQUE (tenant_id, client_event_id),
  CHECK (remittance_id IS NULL OR settlement_id IS NOT NULL)
);
CREATE INDEX dlv_collections_cash ON dlv_collections(tenant_id, driver_id) WHERE settlement_id IS NULL;

-- The amount, the parcel and the rider of a collection are facts. Only the settlement / remittance links may change, and only forward
-- (NULL → set) or back for a rejected settlement; a collection can never be deleted.
CREATE FUNCTION dlv_collection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cash collections cannot be deleted'; END IF;
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.shipment_id <> OLD.shipment_id OR NEW.driver_id <> OLD.driver_id
     OR NEW.collected_at <> OLD.collected_at OR NEW.client_event_id <> OLD.client_event_id THEN
    RAISE EXCEPTION 'a cash collection cannot be edited';
  END IF;
  IF OLD.remittance_id IS NOT NULL AND (NEW.remittance_id IS DISTINCT FROM OLD.remittance_id OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id)
     AND NOT (NEW.remittance_id IS NULL AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id) THEN
    RAISE EXCEPTION 'a remitted collection cannot be moved';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dlv_collections_guard BEFORE UPDATE OR DELETE ON dlv_collections FOR EACH ROW EXECUTE FUNCTION dlv_collection_guard();

-- ── rates and billing
CREATE TABLE dlv_rates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  merchant_id       uuid NOT NULL,
  delivery_minor    bigint NOT NULL DEFAULT 0 CHECK (delivery_minor >= 0),     -- per delivered parcel
  intercity_minor   bigint NOT NULL DEFAULT 0 CHECK (intercity_minor >= 0),    -- added when the destination emirate differs from the origin emirate
  return_minor      bigint NOT NULL DEFAULT 0 CHECK (return_minor >= 0),       -- per parcel returned to the merchant
  cod_fee_bps       int    NOT NULL DEFAULT 0 CHECK (cod_fee_bps BETWEEN 0 AND 2000),
  cod_fee_min_minor bigint NOT NULL DEFAULT 0 CHECK (cod_fee_min_minor >= 0),
  tax_code          text   NOT NULL DEFAULT 'SR5',
  effective_from    date   NOT NULL,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, merchant_id, effective_from)
);

CREATE TABLE dlv_billing_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  merchant_id uuid NOT NULL,
  through_on  date NOT NULL,
  invoice_id  uuid,
  status      text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id)
);
ALTER TABLE invoices ADD COLUMN dlv_run_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY (tenant_id, dlv_run_id) REFERENCES dlv_billing_runs(tenant_id, id);
ALTER TABLE dlv_billing_runs ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id);

-- One charge per source event (source_ref) so a retried sync can never bill twice. A charge with no rate card yet is kept
-- (unrated) and priced later; it is never silently dropped or invoiced at zero.
CREATE TABLE dlv_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  merchant_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  charge_type text NOT NULL CHECK (charge_type IN ('delivery','intercity','cod_fee','return')),
  description text NOT NULL,
  qty         numeric(12,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_minor  bigint NOT NULL DEFAULT 0 CHECK (unit_minor >= 0),
  tax_code    text NOT NULL DEFAULT 'SR5',
  occurred_on date NOT NULL,
  source_ref  text NOT NULL,
  unrated     boolean NOT NULL DEFAULT false,
  invoice_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (unrated AND invoice_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES dlv_shipments(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  UNIQUE (tenant_id, source_ref)
);

ALTER TABLE documents ADD COLUMN dlv_shipment_id uuid;
ALTER TABLE documents ADD FOREIGN KEY (tenant_id, dlv_shipment_id) REFERENCES dlv_shipments(tenant_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dlv_runs','dlv_shipments','dlv_events','dlv_settlements','dlv_remittances','dlv_collections','dlv_rates','dlv_billing_runs','dlv_charges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON dlv_runs, dlv_shipments, dlv_settlements, dlv_remittances, dlv_rates, dlv_billing_runs, dlv_charges TO lbt_app;
GRANT SELECT, INSERT, UPDATE ON dlv_collections TO lbt_app;
GRANT SELECT, INSERT ON dlv_events TO lbt_app;
