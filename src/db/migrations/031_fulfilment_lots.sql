-- Fulfilment lot / batch / expiry / serial traceability. A sub-ledger beneath stock_levels: for tracked SKUs every quantity
-- also lives in exactly one lot, and the lot levels reconcile to the aggregate (see platform/invariants.ts).
ALTER TABLE skus ADD COLUMN tracking text NOT NULL DEFAULT 'none' CHECK (tracking IN ('none','lot','serial'));
ALTER TABLE skus ADD COLUMN rotation text NOT NULL DEFAULT 'fifo' CHECK (rotation IN ('fifo','fefo'));
ALTER TABLE skus ADD COLUMN min_shelf_days int NOT NULL DEFAULT 0 CHECK (min_shelf_days BETWEEN 0 AND 3650);

CREATE TABLE fulfil_lots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  sku_id     uuid NOT NULL,
  lot        text NOT NULL CHECK (length(lot) > 0),
  expires_at date,
  serial_ref text,
  document_id uuid NOT NULL,
  hold       boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sku_id, lot),
  UNIQUE (tenant_id, sku_id, serial_ref)
);
CREATE FUNCTION fulfil_lot_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.sku_id,NEW.lot,NEW.expires_at,NEW.serial_ref,NEW.document_id,NEW.created_by) IS DISTINCT FROM
    (OLD.tenant_id,OLD.sku_id,OLD.lot,OLD.expires_at,OLD.serial_ref,OLD.document_id,OLD.created_by)
 THEN RAISE EXCEPTION 'lot source identity is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fulfil_lot_identity_immutable BEFORE UPDATE ON fulfil_lots FOR EACH ROW EXECUTE FUNCTION fulfil_lot_identity_immutable();

CREATE TABLE stock_lot_levels (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  sku_id      uuid NOT NULL,
  location_id uuid NOT NULL,
  lot_id      uuid NOT NULL,
  on_hand     int NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved    int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (reserved <= on_hand),
  PRIMARY KEY (tenant_id, sku_id, location_id, lot_id),
  FOREIGN KEY (tenant_id, sku_id, location_id) REFERENCES stock_levels(tenant_id, sku_id, location_id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id)
);

ALTER TABLE stock_movements ADD COLUMN lot_id uuid;
ALTER TABLE stock_allocations ADD COLUMN lot_id uuid;
ALTER TABLE stock_adjustments ADD COLUMN lot_id uuid;
ALTER TABLE inbound_receipts ADD COLUMN lot_id uuid;
ALTER TABLE fulfil_return_receipts ADD COLUMN lot_id uuid;
ALTER TABLE stock_movements ADD FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id);
ALTER TABLE stock_allocations ADD FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id);
ALTER TABLE stock_adjustments ADD FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id);
ALTER TABLE inbound_receipts ADD FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id);
ALTER TABLE fulfil_return_receipts ADD FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id);

-- Serial-tracked lines are packed by scanning each serial; one scan per lot per line.
CREATE TABLE fulfil_pack_serials (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  line_id   uuid NOT NULL,
  lot_id    uuid NOT NULL,
  scanned_by uuid REFERENCES users(id),
  scanned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, line_id, lot_id),
  FOREIGN KEY (tenant_id, line_id) REFERENCES fulfil_order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id)
);

-- Immutable quality decisions (hold / release) with the evidence text.
CREATE TABLE fulfil_lot_decisions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  lot_id    uuid NOT NULL,
  hold      boolean NOT NULL,
  reason    text NOT NULL,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id)
);
CREATE TRIGGER fulfil_lot_decisions_immutable BEFORE UPDATE OR DELETE ON fulfil_lot_decisions FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['fulfil_lots','stock_lot_levels','fulfil_pack_serials','fulfil_lot_decisions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON fulfil_lots,stock_lot_levels TO lbt_app;
GRANT SELECT,INSERT,DELETE ON fulfil_pack_serials TO lbt_app;
GRANT SELECT,INSERT ON fulfil_lot_decisions TO lbt_app;
