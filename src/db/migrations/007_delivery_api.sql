-- Delivery integrations: per-merchant API keys (hashed), per-merchant webhook endpoint + SMS opt-in.

CREATE TABLE dlv_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  merchant_id  uuid NOT NULL,
  name         text NOT NULL,
  prefix       text NOT NULL,                      -- first characters of the key, so people can tell keys apart; the key itself is never stored
  key_hash     text NOT NULL UNIQUE,               -- sha256 of the full key
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id)
);

CREATE TABLE dlv_merchant_settings (
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  merchant_id           uuid NOT NULL,
  webhook_url           text CHECK (webhook_url IS NULL OR webhook_url ~ '^https://'),
  webhook_secret_sealed text,                      -- AES-GCM sealed; needed in the clear only to sign a delivery
  webhook_active        boolean NOT NULL DEFAULT false,
  notify_sms            boolean NOT NULL DEFAULT false,   -- the merchant (data controller) has consent to text its consignees
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, merchant_id),
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES parties(tenant_id, id),
  CHECK (NOT webhook_active OR (webhook_url IS NOT NULL AND webhook_secret_sealed IS NOT NULL))
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dlv_api_keys','dlv_merchant_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON dlv_api_keys, dlv_merchant_settings TO lbt_app;
