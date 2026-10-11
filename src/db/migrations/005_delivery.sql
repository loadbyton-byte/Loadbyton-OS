-- Delivery pilot. COD is customer-owned cash, separate from service-fee invoices.
CREATE TABLE delivery_parcels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  party_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  no text NOT NULL,
  external_ref text NOT NULL,
  recipient_name text NOT NULL,
  recipient_phone text NOT NULL,
  address text NOT NULL,
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  tax_code text NOT NULL,
  cod_expected_minor bigint NOT NULL CHECK (cod_expected_minor >= 0),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','out_for_delivery','failed','delivered','returned','cancelled')),
  driver_id uuid,
  route_ref text,
  invoice_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,party_id) REFERENCES parties(tenant_id,id),
  FOREIGN KEY (tenant_id,entity_id) REFERENCES entities(tenant_id,id),
  FOREIGN KEY (tenant_id,driver_id) REFERENCES drivers(tenant_id,id),
  FOREIGN KEY (tenant_id,invoice_id) REFERENCES invoices(tenant_id,id),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,no), UNIQUE (tenant_id,party_id,external_ref),
  CHECK (status <> 'out_for_delivery' OR (driver_id IS NOT NULL AND route_ref IS NOT NULL))
);
ALTER TABLE invoices ADD COLUMN delivery_parcel_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY (tenant_id,delivery_parcel_id) REFERENCES delivery_parcels(tenant_id,id);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parcel_id uuid NOT NULL,
  client_ref text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('delivered','failed','returned')),
  reason text,
  pod_name text,
  cod_collected_minor bigint NOT NULL DEFAULT 0 CHECK (cod_collected_minor >= 0),
  recorded_by uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,parcel_id) REFERENCES delivery_parcels(tenant_id,id),
  UNIQUE (tenant_id,client_ref),
  CHECK ((outcome='delivered' AND pod_name IS NOT NULL) OR (outcome<>'delivered' AND cod_collected_minor=0 AND reason IS NOT NULL))
);
CREATE UNIQUE INDEX delivery_one_success ON delivery_attempts(parcel_id) WHERE outcome='delivered';

-- Finance records what physically arrived; mismatches cannot be silently turned into a match.
CREATE TABLE delivery_cash_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parcel_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  reference text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,parcel_id) REFERENCES delivery_parcels(tenant_id,id),
  UNIQUE (tenant_id,parcel_id), UNIQUE (tenant_id,reference)
);
CREATE TABLE delivery_cod_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parcel_id uuid NOT NULL,
  reason text NOT NULL,
  expected_minor bigint NOT NULL,
  collected_minor bigint NOT NULL,
  received_minor bigint NOT NULL,
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,parcel_id) REFERENCES delivery_parcels(tenant_id,id),
  UNIQUE (tenant_id,parcel_id)
);
CREATE TABLE delivery_remittances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parcel_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reference text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  paid_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,parcel_id) REFERENCES delivery_parcels(tenant_id,id),
  UNIQUE (tenant_id,reference)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['delivery_parcels','delivery_attempts','delivery_cash_receipts','delivery_cod_decisions','delivery_remittances'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
    IF t <> 'delivery_parcels' THEN
      EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()',t);
    END IF;
  END LOOP;
END $$;
CREATE INDEX delivery_work_queue ON delivery_parcels(tenant_id,status,created_at);
CREATE INDEX delivery_driver_queue ON delivery_parcels(tenant_id,driver_id,status);
GRANT SELECT,INSERT,UPDATE ON delivery_parcels TO lbt_app;
GRANT SELECT,INSERT ON delivery_attempts,delivery_cash_receipts,delivery_cod_decisions,delivery_remittances TO lbt_app;
