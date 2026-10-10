-- LOAD|BY|TON Warehouse (contract warehouse / 3PL): owner-separated custody stock on an immutable movement ledger,
-- inbound (ASN → receive), outbound (allocate → pick → dispatch), blind cycle counts with independent approval,
-- and activity billing (rate cards → idempotent charges → invoice).

CREATE TABLE warehouses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,
  name       text NOT NULL,
  address    text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE warehouse_locations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  warehouse_id   uuid NOT NULL,
  code           text NOT NULL,
  kind           text NOT NULL DEFAULT 'storage' CHECK (kind IN ('receiving','storage','quarantine')),
  capacity_units numeric(14,3) CHECK (capacity_units > 0),      -- NULL = not limited
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, warehouse_id, code)
);

-- A SKU belongs to exactly one owner (the customer whose goods these are). Stock is never shared across owners.
CREATE TABLE wh_skus (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  owner_id    uuid NOT NULL,
  code        text NOT NULL,
  description text NOT NULL,
  uom         text NOT NULL DEFAULT 'unit',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, owner_id, id),
  UNIQUE (tenant_id, owner_id, code)
);

-- Balance per (owner, sku, location, lot). The ledger below is the source of truth; `npm run verify` reconciles the two.
CREATE TABLE wh_stock (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  owner_id          uuid NOT NULL,
  sku_id            uuid NOT NULL,
  location_id       uuid NOT NULL,
  lot               text NOT NULL DEFAULT '',
  qty_on_hand       numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  qty_reserved      numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  first_received_at timestamptz NOT NULL DEFAULT now(),          -- FIFO age
  CHECK (qty_reserved <= qty_on_hand),
  FOREIGN KEY (tenant_id, owner_id, sku_id) REFERENCES wh_skus(tenant_id, owner_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES warehouse_locations(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, owner_id, sku_id, location_id, lot)
);

CREATE TABLE wh_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  owner_id    uuid NOT NULL,
  sku_id      uuid NOT NULL,
  location_id uuid NOT NULL,
  lot         text NOT NULL DEFAULT '',
  qty_delta   numeric(14,3) NOT NULL CHECK (qty_delta <> 0),
  kind        text NOT NULL CHECK (kind IN ('receipt','dispatch','transfer_out','transfer_in','adjust')),
  group_id    uuid,                                                -- pairs the two legs of a transfer
  ref_type    text,
  ref_id      uuid,
  reason      text,
  client_ref  text,                                                -- scanner/retry key: a repeat can never post twice
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, owner_id, sku_id) REFERENCES wh_skus(tenant_id, owner_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES warehouse_locations(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, client_ref)
);
CREATE TRIGGER wh_movements_immutable BEFORE UPDATE OR DELETE ON wh_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE INDEX wh_movements_owner_time ON wh_movements (tenant_id, owner_id, created_at);

-- ───────────── inbound
CREATE TABLE wh_inbound (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  no           text NOT NULL,
  owner_id     uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  customer_ref text,
  expected_on  date,
  status       text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','receiving','received','cancelled')),
  notes        text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, owner_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE wh_inbound_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  inbound_id   uuid NOT NULL,
  owner_id     uuid NOT NULL,
  sku_id       uuid NOT NULL,
  qty_expected numeric(14,3) NOT NULL CHECK (qty_expected > 0),
  qty_received numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),    -- good condition
  qty_damaged  numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0),     -- received into quarantine
  FOREIGN KEY (tenant_id, owner_id, inbound_id) REFERENCES wh_inbound(tenant_id, owner_id, id),
  FOREIGN KEY (tenant_id, owner_id, sku_id) REFERENCES wh_skus(tenant_id, owner_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (inbound_id, sku_id)
);

-- ───────────── outbound
CREATE TABLE wh_outbound (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  no           text NOT NULL,
  owner_id     uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  ship_to      text NOT NULL,
  customer_ref text,
  required_by  timestamptz,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new','allocated','picked','dispatched','cancelled')),
  carrier_ref  text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, owner_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE wh_outbound_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  outbound_id    uuid NOT NULL,
  owner_id       uuid NOT NULL,
  sku_id         uuid NOT NULL,
  qty_ordered    numeric(14,3) NOT NULL CHECK (qty_ordered > 0),
  qty_allocated  numeric(14,3) NOT NULL DEFAULT 0,
  qty_picked     numeric(14,3) NOT NULL DEFAULT 0,
  qty_dispatched numeric(14,3) NOT NULL DEFAULT 0,
  CHECK (qty_allocated >= 0 AND qty_allocated <= qty_ordered),
  CHECK (qty_picked >= 0 AND qty_picked <= qty_allocated),
  CHECK (qty_dispatched >= 0 AND qty_dispatched <= qty_picked),
  FOREIGN KEY (tenant_id, owner_id, outbound_id) REFERENCES wh_outbound(tenant_id, owner_id, id),
  FOREIGN KEY (tenant_id, owner_id, sku_id) REFERENCES wh_skus(tenant_id, owner_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (outbound_id, sku_id)
);

-- A reservation of one stock row for one outbound line. Open (reserved|picked) allocations make up wh_stock.qty_reserved.
CREATE TABLE wh_allocations (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  line_id   uuid NOT NULL,
  stock_id  uuid NOT NULL,
  qty       numeric(14,3) NOT NULL CHECK (qty >= 0),
  status    text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','picked','shipped','released')),
  picked_by uuid REFERENCES users(id),
  picked_at timestamptz,
  FOREIGN KEY (tenant_id, line_id) REFERENCES wh_outbound_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, stock_id) REFERENCES wh_stock(tenant_id, id),
  UNIQUE (tenant_id, id)
);

-- ───────────── cycle counts
CREATE TABLE wh_counts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  no           text NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id  uuid,                                              -- NULL = whole warehouse
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','closed','cancelled')),
  created_by   uuid REFERENCES users(id),
  submitted_by uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES warehouse_locations(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE wh_count_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  count_id    uuid NOT NULL,
  owner_id    uuid NOT NULL,
  sku_id      uuid NOT NULL,
  location_id uuid NOT NULL,
  lot         text NOT NULL DEFAULT '',
  system_qty  numeric(14,3) NOT NULL CHECK (system_qty >= 0),    -- snapshot when the sheet was cut (hidden from counters)
  counted_qty numeric(14,3) CHECK (counted_qty >= 0),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','counted','approved','rejected','stale')),
  counted_by  uuid REFERENCES users(id),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  movement_id uuid,
  FOREIGN KEY (tenant_id, count_id) REFERENCES wh_counts(tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id, sku_id) REFERENCES wh_skus(tenant_id, owner_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES warehouse_locations(tenant_id, id),
  FOREIGN KEY (tenant_id, movement_id) REFERENCES wh_movements(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (count_id, owner_id, sku_id, location_id, lot)
);

-- ───────────── activity billing
CREATE TABLE wh_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  owner_id       uuid NOT NULL,
  charge_type    text NOT NULL CHECK (charge_type IN ('storage_unit_day','handling_in_unit','handling_out_unit','outbound_order')),
  unit_minor     bigint NOT NULL CHECK (unit_minor >= 0),
  tax_code       text NOT NULL DEFAULT 'SR5',
  effective_from date NOT NULL,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, owner_id, charge_type, effective_from)
);

CREATE TABLE wh_billing_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  owner_id   uuid NOT NULL,
  through_on date NOT NULL,
  invoice_id uuid,
  status     text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id)
);
ALTER TABLE invoices ADD COLUMN wh_run_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY (tenant_id, wh_run_id) REFERENCES wh_billing_runs(tenant_id, id);
ALTER TABLE wh_billing_runs ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id);

-- One charge per source event (source_ref) so a retried receive/dispatch/accrual can never bill twice.
-- A charge with no rate card yet is kept (unrated) and priced later; it is never silently dropped or invoiced at zero.
CREATE TABLE wh_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  owner_id    uuid NOT NULL,
  charge_type text NOT NULL CHECK (charge_type IN ('storage_unit_day','handling_in_unit','handling_out_unit','outbound_order')),
  description text NOT NULL,
  qty         numeric(14,3) NOT NULL CHECK (qty > 0),
  unit_minor  bigint NOT NULL DEFAULT 0,
  tax_code    text NOT NULL DEFAULT 'SR5',
  occurred_on date NOT NULL,
  source_ref  text NOT NULL,
  unrated     boolean NOT NULL DEFAULT false,
  invoice_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (unrated AND invoice_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  UNIQUE (tenant_id, source_ref)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouses','warehouse_locations','wh_skus','wh_stock','wh_movements','wh_inbound','wh_inbound_lines','wh_outbound',
    'wh_outbound_lines','wh_allocations','wh_counts','wh_count_lines','wh_rates','wh_billing_runs','wh_charges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON warehouses, warehouse_locations, wh_skus, wh_stock, wh_inbound, wh_inbound_lines, wh_outbound,
  wh_outbound_lines, wh_allocations, wh_counts, wh_count_lines, wh_rates, wh_billing_runs, wh_charges TO lbt_app;
GRANT SELECT, INSERT ON wh_movements TO lbt_app;
