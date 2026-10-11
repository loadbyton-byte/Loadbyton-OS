-- Zones, pick waves (wave / zone / batch strategies), kits (assembled or virtual), carton types and order cartonisation.
ALTER TABLE wh_locations ADD COLUMN zone text CHECK (zone IS NULL OR (length(zone) BETWEEN 1 AND 20 AND zone = upper(zone)));
ALTER TABLE skus ADD COLUMN length_mm int CHECK (length_mm IS NULL OR length_mm BETWEEN 1 AND 20000);
ALTER TABLE skus ADD COLUMN width_mm  int CHECK (width_mm  IS NULL OR width_mm  BETWEEN 1 AND 20000);
ALTER TABLE skus ADD COLUMN height_mm int CHECK (height_mm IS NULL OR height_mm BETWEEN 1 AND 20000);
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('receive','receive_damaged','transfer_out','transfer_in','pick_out','stage_in','ship',
  'cancel_out','cancel_return','return_restock','return_quarantine','adjust','site_out','site_in','kit_consume','kit_build'));

CREATE TABLE fulfil_carton_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL, name text NOT NULL,
  inner_l_mm int NOT NULL CHECK (inner_l_mm BETWEEN 1 AND 20000), inner_w_mm int NOT NULL CHECK (inner_w_mm BETWEEN 1 AND 20000), inner_h_mm int NOT NULL CHECK (inner_h_mm BETWEEN 1 AND 20000),
  max_weight_g int NOT NULL CHECK (max_weight_g > 0), tare_g int NOT NULL DEFAULT 0 CHECK (tare_g >= 0), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id), UNIQUE (tenant_id, code)
);
CREATE TABLE fulfil_order_cartons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), order_id uuid NOT NULL,
  seq int NOT NULL CHECK (seq > 0), carton_type_id uuid NOT NULL, weight_g int CHECK (weight_g IS NULL OR weight_g > 0),
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES fulfil_orders(tenant_id, id), FOREIGN KEY (tenant_id, carton_type_id) REFERENCES fulfil_carton_types(tenant_id, id),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, order_id, seq)
);
CREATE TABLE fulfil_order_carton_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id), carton_id uuid NOT NULL, sku_id uuid NOT NULL, qty int NOT NULL CHECK (qty > 0),
  PRIMARY KEY (carton_id, sku_id), FOREIGN KEY (tenant_id, carton_id) REFERENCES fulfil_order_cartons(tenant_id, id), FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id)
);

CREATE TABLE fulfil_waves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), no text NOT NULL,
  strategy text NOT NULL CHECK (strategy IN ('wave','zone','batch')), status text NOT NULL DEFAULT 'released' CHECK (status IN ('released','completed','cancelled')),
  note text, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, no)
);
CREATE TABLE fulfil_wave_orders (
  tenant_id uuid NOT NULL REFERENCES tenants(id), wave_id uuid NOT NULL, order_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (wave_id, order_id), FOREIGN KEY (tenant_id, wave_id) REFERENCES fulfil_waves(tenant_id, id), FOREIGN KEY (tenant_id, order_id) REFERENCES fulfil_orders(tenant_id, id)
);
CREATE UNIQUE INDEX fulfil_wave_orders_one_active ON fulfil_wave_orders (tenant_id, order_id) WHERE active;
CREATE TABLE fulfil_pick_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), wave_id uuid NOT NULL, zone text NOT NULL DEFAULT '*',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','done')), assigned_to uuid REFERENCES users(id),
  claimed_at timestamptz, done_at timestamptz, FOREIGN KEY (tenant_id, wave_id) REFERENCES fulfil_waves(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (wave_id, zone)
);

CREATE TABLE fulfil_kits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), sku_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('assemble','virtual')), active boolean NOT NULL DEFAULT true, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id), UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX fulfil_kits_one_active ON fulfil_kits (tenant_id, sku_id) WHERE active;
CREATE TABLE fulfil_kit_components (
  tenant_id uuid NOT NULL REFERENCES tenants(id), kit_id uuid NOT NULL, sku_id uuid NOT NULL, qty int NOT NULL CHECK (qty BETWEEN 1 AND 10000),
  PRIMARY KEY (kit_id, sku_id), FOREIGN KEY (tenant_id, kit_id) REFERENCES fulfil_kits(tenant_id, id), FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id)
);
CREATE TABLE fulfil_order_kit_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id), order_id uuid NOT NULL, kit_sku_id uuid NOT NULL, qty int NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, kit_sku_id), FOREIGN KEY (tenant_id, order_id) REFERENCES fulfil_orders(tenant_id, id), FOREIGN KEY (tenant_id, kit_sku_id) REFERENCES skus(tenant_id, id)
);
CREATE TABLE fulfil_kit_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), kit_id uuid NOT NULL, location_id uuid NOT NULL, qty int NOT NULL CHECK (qty > 0),
  token text NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, kit_id) REFERENCES fulfil_kits(tenant_id, id), FOREIGN KEY (tenant_id, location_id) REFERENCES wh_locations(tenant_id, id),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, token)
);
CREATE TABLE fulfil_kit_build_lots (
  tenant_id uuid NOT NULL REFERENCES tenants(id), build_id uuid NOT NULL, sku_id uuid NOT NULL, lot_id uuid, qty int NOT NULL CHECK (qty > 0),
  FOREIGN KEY (tenant_id, build_id) REFERENCES fulfil_kit_builds(tenant_id, id), FOREIGN KEY (tenant_id, sku_id) REFERENCES skus(tenant_id, id), FOREIGN KEY (tenant_id, lot_id) REFERENCES fulfil_lots(tenant_id, id)
);
CREATE TRIGGER fulfil_kit_components_immutable BEFORE UPDATE OR DELETE ON fulfil_kit_components FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE FUNCTION fulfil_kit_definition_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.tenant_id,NEW.sku_id,NEW.mode,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.sku_id,OLD.mode,OLD.created_by,OLD.created_at) OR (OLD.active=false AND NEW.active) THEN RAISE EXCEPTION 'kit definitions are immutable; retire the kit and define a new one'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fulfil_kit_definition_guard BEFORE UPDATE OR DELETE ON fulfil_kits FOR EACH ROW EXECUTE FUNCTION fulfil_kit_definition_guard();
CREATE TRIGGER fulfil_kit_builds_immutable BEFORE UPDATE OR DELETE ON fulfil_kit_builds FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER fulfil_kit_build_lots_immutable BEFORE UPDATE OR DELETE ON fulfil_kit_build_lots FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['fulfil_carton_types','fulfil_order_cartons','fulfil_order_carton_lines','fulfil_waves','fulfil_wave_orders','fulfil_pick_tasks','fulfil_kits','fulfil_kit_components','fulfil_order_kit_lines','fulfil_kit_builds','fulfil_kit_build_lots'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON fulfil_carton_types,fulfil_order_cartons,fulfil_order_carton_lines,fulfil_waves,fulfil_wave_orders,fulfil_pick_tasks,fulfil_order_kit_lines TO lbt_app;
GRANT SELECT,INSERT,UPDATE ON fulfil_kits TO lbt_app;
GRANT SELECT,INSERT ON fulfil_kit_components TO lbt_app;
GRANT SELECT,INSERT ON fulfil_kit_builds,fulfil_kit_build_lots TO lbt_app;
