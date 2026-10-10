-- LOAD|BY|TON E-commerce fulfilment: merchant SKUs, locations, immutable stock ledger, inbound, orders with reservation,
-- pick/pack/ship, returns, count adjustments with independent approval, and activity billing.
-- Stock integrity is enforced here, not only in code: on_hand/reserved can never go negative or oversold, and every
-- quantity chain on an order line (allocated >= picked >= packed >= shipped) is a CHECK constraint.

CREATE TABLE wh_locations (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code      text NOT NULL,
  kind      text NOT NULL DEFAULT 'bin' CHECK (kind IN ('bin','receiving','staging','quarantine')),   -- only 'bin' is allocatable
  note      text,
  active    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE skus (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  party_id  uuid NOT NULL,                              -- the merchant that owns the stock
  code      text NOT NULL,
  name      text NOT NULL,
  barcode   text,
  unit_weight_g int CHECK (unit_weight_g IS NULL OR unit_weight_g >= 0),
  reorder_point int NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  active    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, party_id, code)
);
CREATE UNIQUE INDEX skus_barcode_unique ON skus (tenant_id, party_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE stock_levels (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  sku_id      uuid NOT NULL,
  location_id uuid NOT NULL,
  on_hand     int NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved    int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (reserved <= on_hand),                          -- overselling is impossible by construction
  PRIMARY KEY (tenant_id, sku_id, location_id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES wh_locations(tenant_id, id)
);

-- Append-only ledger. Every change to on_hand has exactly one row here; levels must reconcile to the sum (see invariants).
CREATE TABLE stock_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  sku_id      uuid NOT NULL,
  location_id uuid NOT NULL,
  delta       int NOT NULL CHECK (delta <> 0),
  kind        text NOT NULL CHECK (kind IN ('receive','receive_damaged','transfer_out','transfer_in','pick_out','stage_in','ship',
                                            'cancel_out','cancel_return','return_restock','return_quarantine','adjust')),
  ref_type    text,
  ref_id      uuid,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES wh_locations(tenant_id, id)
);
CREATE INDEX stock_movements_sku ON stock_movements (tenant_id, sku_id, created_at);
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────── inbound
CREATE TABLE inbound_shipments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  no          text NOT NULL,
  party_id    uuid NOT NULL,
  reference   text,
  expected_at timestamptz,
  status      text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','receiving','received','closed','cancelled')),
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE inbound_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  inbound_id   uuid NOT NULL,
  sku_id       uuid NOT NULL,
  expected_qty int NOT NULL CHECK (expected_qty > 0),
  received_qty int NOT NULL DEFAULT 0 CHECK (received_qty >= 0),    -- good units put into stock
  damaged_qty  int NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),     -- units sent to quarantine
  FOREIGN KEY (tenant_id, inbound_id) REFERENCES inbound_shipments(tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, inbound_id, sku_id)
);

-- One row per receive action; the client token makes a double submit a no-op.
CREATE TABLE inbound_receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  line_id     uuid NOT NULL,
  good_qty    int NOT NULL CHECK (good_qty >= 0),
  damaged_qty int NOT NULL CHECK (damaged_qty >= 0),
  location_id uuid NOT NULL,
  token       text NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (good_qty + damaged_qty > 0),
  FOREIGN KEY (tenant_id, line_id) REFERENCES inbound_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES wh_locations(tenant_id, id),
  UNIQUE (tenant_id, token)
);
CREATE TRIGGER inbound_receipts_immutable BEFORE UPDATE OR DELETE ON inbound_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────── merchant orders
CREATE TABLE fulfil_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  party_id      uuid NOT NULL,
  channel       text NOT NULL DEFAULT 'manual',
  external_ref  text NOT NULL,                          -- the merchant's order number: import/API retries cannot create a second order
  ship_to_name  text NOT NULL,
  ship_to_phone text,
  ship_to_address text NOT NULL,
  ship_to_city  text,
  ship_to_country text NOT NULL DEFAULT 'AE',
  ordered_at    timestamptz NOT NULL DEFAULT now(),
  ship_by       timestamptz,
  allow_partial boolean NOT NULL DEFAULT false,         -- false = reserve all lines or none (no stranded stock)
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','backordered','allocated','picking','picked','packed','shipped','cancelled')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  shipped_at    timestamptz,
  cancelled_at  timestamptz,
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no),
  UNIQUE (tenant_id, party_id, external_ref)
);

CREATE TABLE fulfil_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  order_id      uuid NOT NULL,
  sku_id        uuid NOT NULL,
  qty           int NOT NULL CHECK (qty > 0),
  allocated_qty int NOT NULL DEFAULT 0,                 -- reserved or already picked
  picked_qty    int NOT NULL DEFAULT 0,
  packed_qty    int NOT NULL DEFAULT 0,
  shipped_qty   int NOT NULL DEFAULT 0,
  closed_qty    int NOT NULL DEFAULT 0,                 -- units given up (short-closed / cancelled); never silently dropped
  CHECK (allocated_qty >= 0 AND picked_qty >= 0 AND packed_qty >= 0 AND shipped_qty >= 0 AND closed_qty >= 0),
  CHECK (allocated_qty + closed_qty <= qty),
  CHECK (picked_qty <= allocated_qty),
  CHECK (packed_qty <= picked_qty),
  CHECK (shipped_qty <= packed_qty),
  FOREIGN KEY (tenant_id, order_id) REFERENCES fulfil_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_id, sku_id)
);

-- Reservation of a line against a bin. Reserved remainder = qty - picked_qty.
CREATE TABLE stock_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  line_id     uuid NOT NULL,
  sku_id      uuid NOT NULL,
  location_id uuid NOT NULL,
  qty         int NOT NULL CHECK (qty > 0),
  picked_qty  int NOT NULL DEFAULT 0 CHECK (picked_qty >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (picked_qty <= qty),
  FOREIGN KEY (tenant_id, line_id) REFERENCES fulfil_order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES wh_locations(tenant_id, id)
);
CREATE INDEX stock_allocations_line ON stock_allocations (tenant_id, line_id);

CREATE TABLE fulfil_shipments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  order_id    uuid NOT NULL,
  carrier     text NOT NULL,
  tracking_no text NOT NULL,                            -- entered by the packer; carrier label/API integrations are not built
  cartons     int NOT NULL DEFAULT 1 CHECK (cartons > 0),
  weight_g    int CHECK (weight_g IS NULL OR weight_g > 0),
  shipped_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES fulfil_orders(tenant_id, id),
  UNIQUE (tenant_id, order_id),
  UNIQUE (tenant_id, carrier, tracking_no)
);

-- ───────── returns
CREATE TABLE fulfil_returns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  no         text NOT NULL,
  party_id   uuid NOT NULL,
  order_id   uuid,
  reason     text,
  status     text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','received','closed','cancelled')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz,
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES fulfil_orders(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE fulfil_return_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  return_id       uuid NOT NULL,
  sku_id          uuid NOT NULL,
  expected_qty    int NOT NULL CHECK (expected_qty > 0),
  restocked_qty   int NOT NULL DEFAULT 0 CHECK (restocked_qty >= 0),
  quarantined_qty int NOT NULL DEFAULT 0 CHECK (quarantined_qty >= 0),
  disposed_qty    int NOT NULL DEFAULT 0 CHECK (disposed_qty >= 0),
  CHECK (restocked_qty + quarantined_qty + disposed_qty <= expected_qty),
  FOREIGN KEY (tenant_id, return_id) REFERENCES fulfil_returns(tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, return_id, sku_id)
);

CREATE TABLE fulfil_return_receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  line_id     uuid NOT NULL,
  qty         int NOT NULL CHECK (qty > 0),
  disposition text NOT NULL CHECK (disposition IN ('restock','quarantine','dispose')),
  location_id uuid,
  token       text NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, line_id) REFERENCES fulfil_return_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES wh_locations(tenant_id, id),
  UNIQUE (tenant_id, token)
);
CREATE TRIGGER fulfil_return_receipts_immutable BEFORE UPDATE OR DELETE ON fulfil_return_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────── counts and adjustments (independent approval)
CREATE TABLE stock_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  sku_id       uuid NOT NULL,
  location_id  uuid NOT NULL,
  system_qty   int NOT NULL CHECK (system_qty >= 0),    -- on hand when the count was taken
  counted_qty  int NOT NULL CHECK (counted_qty >= 0),
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','stale')),
  requested_by uuid REFERENCES users(id),
  decided_by   uuid REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decision_note text,
  CHECK (counted_qty <> system_qty),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES wh_locations(tenant_id, id)
);

-- ───────── activity billing
CREATE TABLE fulfil_rates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  party_id   uuid NOT NULL,
  code       text NOT NULL CHECK (code IN ('receive_unit','pick_order','pick_unit','pack_order','return_unit','storage_location_month')),
  unit_minor bigint NOT NULL CHECK (unit_minor >= 0),
  tax_code   text NOT NULL DEFAULT 'SR5',
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, party_id, code)
);

-- A charge is created from an operational event at the rate then in force (rate changes never rewrite history).
-- source_key makes each event bill at most once, however often it is retried or replayed.
CREATE TABLE fulfil_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  party_id    uuid NOT NULL,
  code        text NOT NULL,
  description text NOT NULL,
  qty         int NOT NULL CHECK (qty > 0),
  unit_minor  bigint NOT NULL CHECK (unit_minor > 0),
  tax_code    text NOT NULL DEFAULT 'SR5',
  source_key  text NOT NULL,
  order_id    uuid,
  invoice_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES fulfil_orders(tenant_id, id),
  UNIQUE (tenant_id, source_key)
);
CREATE INDEX fulfil_charges_unbilled ON fulfil_charges (tenant_id, party_id) WHERE invoice_id IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wh_locations','skus','stock_levels','stock_movements','inbound_shipments','inbound_lines','inbound_receipts',
    'fulfil_orders','fulfil_order_lines','stock_allocations','fulfil_shipments','fulfil_returns','fulfil_return_lines','fulfil_return_receipts',
    'stock_adjustments','fulfil_rates','fulfil_charges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON wh_locations, skus, stock_levels, inbound_shipments, inbound_lines, fulfil_orders, fulfil_order_lines,
  stock_allocations, fulfil_shipments, fulfil_returns, fulfil_return_lines, stock_adjustments, fulfil_rates, fulfil_charges TO lbt_app;
GRANT SELECT, INSERT ON stock_movements, inbound_receipts, fulfil_return_receipts TO lbt_app;
