-- E-invoicing as a paid add-on: per-workspace activation lifecycle, provider credentials held away from the tenant role, retry bookkeeping,
-- supplier invoices received through the provider, and webhook de-duplication.

-- Tenant-visible lifecycle. A workspace can only ask for activation; provider, taxpayer, allowance and the active/suspended states are set by platform staff.
CREATE TABLE einvoice_service (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  state text NOT NULL DEFAULT 'not_activated' CHECK (state IN ('not_activated','onboarding','active','suspended')),
  package text,
  provider text,
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','live')),
  taxpayer_ref text,                                   -- the provider's identifier for this client's tax registration (for example a Wafeq txpay_ id); not a secret
  allowance_docs integer CHECK (allowance_docs IS NULL OR allowance_docs >= 0),
  used_docs integer NOT NULL DEFAULT 0 CHECK (used_docs >= 0),
  period_ends date,
  payment_note text,
  requested_by uuid REFERENCES users(id), requested_at timestamptz,
  activated_by uuid REFERENCES users(id), activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'active' OR (provider IS NOT NULL AND taxpayer_ref IS NOT NULL))
);

-- The tenant application role may only move its own row between not_activated and onboarding and may not touch anything staff owns.
CREATE FUNCTION einvoice_service_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF current_user = 'lbt_app' THEN
    IF NEW.state NOT IN ('not_activated','onboarding') OR (TG_OP = 'UPDATE' AND OLD.state IN ('active','suspended')) THEN
      RAISE EXCEPTION 'only platform staff can change an active e-invoicing service'; END IF;
    IF NEW.provider IS NOT NULL OR NEW.taxpayer_ref IS NOT NULL OR NEW.allowance_docs IS NOT NULL OR NEW.used_docs <> 0 OR NEW.activated_by IS NOT NULL THEN
      RAISE EXCEPTION 'provider, taxpayer and allowance are set by platform staff'; END IF;
  END IF;
  RETURN NEW; END $$;
CREATE TRIGGER einvoice_service_guard BEFORE INSERT OR UPDATE ON einvoice_service FOR EACH ROW EXECUTE FUNCTION einvoice_service_guard();
ALTER TABLE einvoice_service ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON einvoice_service USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE ON einvoice_service TO lbt_app;

-- Provider credentials: AES-256-GCM ciphertext written by platform staff only. The workspace role can read its own ciphertext (the submit path decrypts it
-- with the server key, as for the accounting connection) but can never write it, and no screen shows it.
CREATE TABLE einvoice_credentials (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  provider text NOT NULL,
  credentials_enc text NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE einvoice_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON einvoice_credentials USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON einvoice_credentials FROM lbt_app;
GRANT SELECT ON einvoice_credentials TO lbt_app;

-- The workspace role cannot edit its own allowance counter; it can only spend one unit of its own allowance, and only while allowance remains.
CREATE FUNCTION einvoice_consume_allowance() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid := nullif(current_setting('app.tenant_id',true),'')::uuid; n integer;
BEGIN
  UPDATE einvoice_service SET used_docs = used_docs + 1, updated_at = now()
   WHERE tenant_id = t AND state IN ('onboarding','active') AND (allowance_docs IS NULL OR used_docs < allowance_docs) RETURNING used_docs INTO n;
  IF n IS NULL THEN RAISE EXCEPTION 'the e-invoicing allowance for this workspace is used up'; END IF;
  RETURN n; END $$;
REVOKE ALL ON FUNCTION einvoice_consume_allowance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION einvoice_consume_allowance() TO lbt_app;

-- Retry bookkeeping. A transient provider failure leaves the document 'generated' with a next attempt time instead of failing it.
ALTER TABLE einvoice_documents ADD COLUMN payload_json jsonb;               -- provider-neutral copy of the same document, frozen with the XML
ALTER TABLE einvoice_documents ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE einvoice_documents ADD COLUMN next_retry_at timestamptz;
ALTER TABLE einvoice_documents ADD COLUMN last_error text;
ALTER TABLE einvoice_documents ADD COLUMN queued_by uuid REFERENCES users(id);
ALTER TABLE einvoice_documents ADD COLUMN tdd_status text;                -- FTA reporting state, tracked separately from delivery
-- Reporting state and the provider's wording may still be updated on an accepted document; its identity, payload and decision stay final.
CREATE OR REPLACE FUNCTION einvoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'e-invoice records are never deleted'; END IF;
 IF NEW.payload_xml IS DISTINCT FROM OLD.payload_xml OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256 OR NEW.number IS DISTINCT FROM OLD.number OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.payload_json IS DISTINCT FROM OLD.payload_json THEN RAISE EXCEPTION 'a generated e-invoice payload is immutable'; END IF;
 IF OLD.status = 'accepted' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN RAISE EXCEPTION 'an accepted e-invoice is final'; END IF;
 RETURN NEW; END $$;
CREATE INDEX einvoice_retry_due ON einvoice_documents (next_retry_at) WHERE status = 'generated' AND next_retry_at IS NOT NULL;
CREATE UNIQUE INDEX einvoice_provider_ref ON einvoice_documents (tenant_id, provider, provider_ref) WHERE provider_ref IS NOT NULL AND status IN ('submitted','accepted');

-- Supplier invoices the provider received for a workspace.
CREATE TABLE einvoice_inbound (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL,
  provider_doc_id text NOT NULL,
  number text, sender_name text, currency text, total_minor bigint,
  issued_on date,
  status text NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_doc_id)
);
ALTER TABLE einvoice_inbound ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON einvoice_inbound USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON einvoice_inbound TO lbt_app;

-- Webhook de-duplication (delivery is at-least-once). Platform-only.
CREATE TABLE einvoice_webhook_events (
  provider text NOT NULL, event_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
REVOKE ALL ON einvoice_webhook_events FROM lbt_app;
