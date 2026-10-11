-- Storage pricing bases beyond closing occupied locations (pallet positions, stock cbm, daily peaks) and future-dated contract amendments.
ALTER TABLE wh_locations ADD COLUMN pallet_positions numeric(6,2) CHECK (pallet_positions IS NULL OR pallet_positions > 0);
ALTER TABLE skus ADD COLUMN unit_cbm numeric(10,6) CHECK (unit_cbm IS NULL OR unit_cbm > 0);

ALTER TABLE fulfil_storage_contracts DROP CONSTRAINT fulfil_storage_contracts_basis_check;
ALTER TABLE fulfil_storage_contracts ADD CONSTRAINT fulfil_storage_contracts_basis_check CHECK (basis IN
  ('closing_occupied_location','closing_occupied_pallet','closing_stock_cbm','peak_occupied_location','peak_occupied_pallet','peak_stock_cbm'));

ALTER TABLE fulfil_charges ALTER COLUMN qty TYPE numeric(12,3);
ALTER TABLE fulfil_storage_days ADD COLUMN measure_qty numeric(14,3);
UPDATE fulfil_storage_days SET measure_qty = occupied_locations;
ALTER TABLE fulfil_storage_days ALTER COLUMN measure_qty SET NOT NULL;
ALTER TABLE fulfil_storage_days ADD CONSTRAINT fulfil_storage_days_measure CHECK (measure_qty >= 0);
ALTER TABLE fulfil_storage_days ADD COLUMN peak_at timestamptz;
ALTER TABLE fulfil_storage_days ADD COLUMN amendment_id uuid;

CREATE TABLE fulfil_storage_amendments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), contract_id uuid NOT NULL,
 reference uuid NOT NULL, effective_from date NOT NULL, document_id uuid NOT NULL,
 basis text NOT NULL CHECK (basis IN ('closing_occupied_location','closing_occupied_pallet','closing_stock_cbm','peak_occupied_location','peak_occupied_pallet','peak_stock_cbm')),
 unit_minor bigint NOT NULL CHECK (unit_minor BETWEEN 0 AND 100000000), tax_code text NOT NULL CHECK (tax_code IN ('SR5','ZR0','EX0','OOS')),
 scope text NOT NULL, reviewer text NOT NULL, approved_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, contract_id) REFERENCES fulfil_storage_contracts(tenant_id, id),
 FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, reference), UNIQUE (tenant_id, contract_id, effective_from)
);
ALTER TABLE fulfil_storage_days ADD FOREIGN KEY (tenant_id, amendment_id) REFERENCES fulfil_storage_amendments(tenant_id, id);
CREATE TRIGGER fulfil_storage_amendment_immutable BEFORE UPDATE OR DELETE ON fulfil_storage_amendments FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE fulfil_storage_amendments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fulfil_storage_amendments USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON fulfil_storage_amendments TO lbt_app;
