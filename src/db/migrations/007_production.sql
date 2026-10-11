-- Production adapters, immutable checkout snapshots and reviewable provider exceptions.
ALTER TABLE orders ADD COLUMN checkout_url text;
ALTER TABLE orders ADD COLUMN merchant_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE FUNCTION protect_order_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.tenant_id,NEW.plan_version_id,NEW.lines,NEW.currency,NEW.subtotal_minor,NEW.tax_minor,NEW.total_minor,NEW.tax_note,NEW.reference,NEW.provider,NEW.created_by,NEW.merchant_snapshot)
 IS DISTINCT FROM
 (OLD.tenant_id,OLD.plan_version_id,OLD.lines,OLD.currency,OLD.subtotal_minor,OLD.tax_minor,OLD.total_minor,OLD.tax_note,OLD.reference,OLD.provider,OLD.created_by,OLD.merchant_snapshot)
 THEN RAISE EXCEPTION 'order contract is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_contract_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_contract();
CREATE TRIGGER order_no_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE outbox ADD COLUMN lease_until timestamptz;
ALTER TABLE outbox ADD COLUMN lease_token text;
ALTER TABLE provision_jobs ADD COLUMN lease_until timestamptz;
ALTER TABLE provision_jobs ADD COLUMN lease_token text;
CREATE TABLE user_mfa (
 user_id uuid PRIMARY KEY REFERENCES users(id), secret_encrypted text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, last_step bigint NOT NULL DEFAULT -1,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_staff ADD COLUMN last_totp_step bigint NOT NULL DEFAULT -1;
ALTER TABLE sessions ADD COLUMN company_mfa_ok boolean NOT NULL DEFAULT false;
CREATE TABLE data_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 requested_by uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('access','correction','deletion')),
 reason text NOT NULL, status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','reviewing','approved','rejected','completed')),
 decision_by uuid REFERENCES users(id), decision_reason text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(tenant_id,id)
);
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_requests USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT,UPDATE ON data_requests TO lbt_app;
