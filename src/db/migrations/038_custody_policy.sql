-- Custody warehouse: owner policies (backorders, returns), approved bonded/liability terms, customer returns and bonded release evidence.
ALTER TABLE warehouse_locations ADD COLUMN bonded boolean NOT NULL DEFAULT false;
ALTER TABLE wh_skus ADD COLUMN barcode text;
CREATE UNIQUE INDEX wh_skus_barcode_unique ON wh_skus (tenant_id, owner_id, barcode) WHERE barcode IS NOT NULL;
ALTER TABLE wh_skus ADD COLUMN declared_unit_minor bigint CHECK (declared_unit_minor IS NULL OR declared_unit_minor BETWEEN 1 AND 1000000000);
ALTER TABLE wh_outbound ADD COLUMN parent_id uuid;
ALTER TABLE wh_outbound ADD COLUMN release_document_id uuid;
ALTER TABLE wh_outbound ADD FOREIGN KEY (tenant_id, parent_id) REFERENCES wh_outbound(tenant_id, id);
ALTER TABLE wh_outbound ADD FOREIGN KEY (tenant_id, release_document_id) REFERENCES documents(tenant_id, id);

CREATE TABLE wh_owner_policy (
 tenant_id uuid NOT NULL REFERENCES tenants(id), owner_id uuid NOT NULL,
 backorder_policy text NOT NULL DEFAULT 'close' CHECK (backorder_policy IN ('close','backorder')),
 returns_policy text NOT NULL DEFAULT 'not_accepted' CHECK (returns_policy IN ('not_accepted','quarantine_inspect')),
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, owner_id), FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id)
);
CREATE TABLE wh_owner_terms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), reference uuid NOT NULL, owner_id uuid NOT NULL,
 valid_from date NOT NULL, valid_until date NOT NULL CHECK (valid_until >= valid_from), bonded boolean NOT NULL,
 liability_cap_minor bigint CHECK (liability_cap_minor IS NULL OR liability_cap_minor > 0),
 document_id uuid NOT NULL, reviewer text NOT NULL, scope text NOT NULL, approved_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id), FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, reference)
);
CREATE TRIGGER wh_owner_terms_immutable BEFORE UPDATE OR DELETE ON wh_owner_terms FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE wh_returns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), no text NOT NULL, owner_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 outbound_id uuid, reference text, status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','receiving','closed','cancelled')),
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 FOREIGN KEY (tenant_id, owner_id) REFERENCES parties(tenant_id, id), FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouses(tenant_id, id),
 FOREIGN KEY (tenant_id, outbound_id) REFERENCES wh_outbound(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, no)
);
CREATE TABLE wh_return_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), return_id uuid NOT NULL, owner_id uuid NOT NULL, sku_id uuid NOT NULL,
 qty_expected numeric(14,3) NOT NULL CHECK (qty_expected > 0), qty_received numeric(14,3) NOT NULL DEFAULT 0, qty_restocked numeric(14,3) NOT NULL DEFAULT 0, qty_disposed numeric(14,3) NOT NULL DEFAULT 0,
 CHECK (qty_received >= 0 AND qty_restocked + qty_disposed <= qty_received),
 FOREIGN KEY (tenant_id, return_id) REFERENCES wh_returns(tenant_id, id), FOREIGN KEY (tenant_id, owner_id, sku_id) REFERENCES wh_skus(tenant_id, owner_id, id),
 UNIQUE (tenant_id, id), UNIQUE (return_id, sku_id)
);
-- Each received lot of a return line keeps its quarantine home so restock / disposal can find the stock.
CREATE TABLE wh_return_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), line_id uuid NOT NULL, lot text NOT NULL, location_id uuid NOT NULL,
 qty numeric(14,3) NOT NULL CHECK (qty > 0), restocked numeric(14,3) NOT NULL DEFAULT 0, disposed numeric(14,3) NOT NULL DEFAULT 0, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (restocked + disposed <= qty), FOREIGN KEY (tenant_id, line_id) REFERENCES wh_return_lines(tenant_id, id), FOREIGN KEY (tenant_id, location_id) REFERENCES warehouse_locations(tenant_id, id), UNIQUE (tenant_id, id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['wh_owner_policy','wh_owner_terms','wh_returns','wh_return_lines','wh_return_receipts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON wh_owner_policy, wh_returns, wh_return_lines, wh_return_receipts TO lbt_app;
GRANT SELECT,INSERT ON wh_owner_terms TO lbt_app;
