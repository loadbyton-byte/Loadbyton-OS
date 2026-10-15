-- Booking and labels through a carrier's API. Credentials are sealed; a booking is written first as 'requested' (so a crash cannot book twice) and completed with the carrier's tracking number and label.
CREATE TABLE carrier_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), carrier text NOT NULL CHECK (carrier IN ('dhl_express')), label text NOT NULL,
 environment text NOT NULL CHECK (environment IN ('test','live')), credentials_sealed text NOT NULL, shipper jsonb NOT NULL, product_domestic text NOT NULL DEFAULT 'N', status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id), UNIQUE (tenant_id, label)
);
CREATE TABLE carrier_shipments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), order_id uuid NOT NULL, account_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','booked','failed')), tracking_no text, label_format text, label_key text, label_sha256 text, error text,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), booked_at timestamptz,
 FOREIGN KEY (tenant_id, order_id) REFERENCES fulfil_orders(tenant_id, id), FOREIGN KEY (tenant_id, account_id) REFERENCES carrier_accounts(tenant_id, id), UNIQUE (tenant_id, id),
 CHECK (status <> 'booked' OR (tracking_no IS NOT NULL AND label_key IS NOT NULL AND booked_at IS NOT NULL))
);
CREATE UNIQUE INDEX carrier_shipments_one_live ON carrier_shipments (order_id) WHERE status IN ('requested','booked');
CREATE UNIQUE INDEX carrier_shipments_tracking ON carrier_shipments (account_id, tracking_no) WHERE tracking_no IS NOT NULL;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['carrier_accounts','carrier_shipments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON carrier_accounts, carrier_shipments TO lbt_app;
