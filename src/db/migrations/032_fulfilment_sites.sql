-- Multi-site fulfilment: sites own bins; orders may be pinned to a site; stock moves between sites through a TRANSIT location
-- on a two-step (dispatch / receive) transfer document with visible variances.
CREATE TABLE fulfil_sites (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code      text NOT NULL,
  name      text NOT NULL,
  active    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
ALTER TABLE wh_locations ADD COLUMN site_id uuid;
ALTER TABLE wh_locations ADD FOREIGN KEY (tenant_id, site_id) REFERENCES fulfil_sites(tenant_id, id);
ALTER TABLE fulfil_orders ADD COLUMN site_id uuid;
ALTER TABLE fulfil_orders ADD FOREIGN KEY (tenant_id, site_id) REFERENCES fulfil_sites(tenant_id, id);

ALTER TABLE wh_locations DROP CONSTRAINT wh_locations_kind_check;
ALTER TABLE wh_locations ADD CONSTRAINT wh_locations_kind_check CHECK (kind IN ('bin','receiving','staging','quarantine','transit'));
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('receive','receive_damaged','transfer_out','transfer_in','pick_out','stage_in','ship',
  'cancel_out','cancel_return','return_restock','return_quarantine','adjust','site_out','site_in'));

CREATE TABLE fulfil_site_transfers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  no         text NOT NULL,
  from_site  uuid NOT NULL,
  to_site    uuid NOT NULL,
  status     text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','dispatched','received','cancelled')),
  notes      text,
  variance   boolean NOT NULL DEFAULT false,          -- closed with units still unreceived (stay in TRANSIT until counted off)
  variance_reason text,
  created_by uuid REFERENCES users(id),
  dispatched_by uuid REFERENCES users(id),
  received_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  received_at timestamptz,
  CHECK (from_site <> to_site),
  FOREIGN KEY (tenant_id, from_site) REFERENCES fulfil_sites(tenant_id, id),
  FOREIGN KEY (tenant_id, to_site) REFERENCES fulfil_sites(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);
CREATE TABLE fulfil_site_transfer_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  transfer_id uuid NOT NULL,
  sku_id      uuid NOT NULL,
  lot_id      uuid,
  from_location_id uuid NOT NULL,
  qty         int NOT NULL CHECK (qty > 0),
  received_qty int NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  CHECK (received_qty <= qty),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES fulfil_site_transfers(tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id),
  FOREIGN KEY (tenant_id, from_location_id) REFERENCES wh_locations(tenant_id, id),
  UNIQUE (tenant_id, id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['fulfil_sites','fulfil_site_transfers','fulfil_site_transfer_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON fulfil_sites,fulfil_site_transfers,fulfil_site_transfer_lines TO lbt_app;
