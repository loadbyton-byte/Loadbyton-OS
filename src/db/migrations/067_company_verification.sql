-- Company verification at registration. A new workspace starts UNVERIFIED and cannot write until its owner has confirmed the email address and a mobile number,
-- uploaded a trade licence, and platform staff have reviewed it. Identity keys (licence, tax number, mobile number, canonical email, company name) are unique across
-- ALL workspaces including rejected ones, so one business cannot hold several free workspaces.
ALTER TABLE tenants
 ADD COLUMN verification_status text NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('unverified','in_review','verified','rejected')),
 ADD COLUMN verification_note text, ADD COLUMN verification_decided_by uuid REFERENCES users(id), ADD COLUMN verification_decided_at timestamptz,
 ADD COLUMN risk_score int NOT NULL DEFAULT 0, ADD COLUMN risk_flags jsonb NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
UPDATE users SET email_verified_at = now();

CREATE TABLE tenant_kyc (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), owner_user_id uuid NOT NULL REFERENCES users(id), legal_name text NOT NULL, name_key text NOT NULL,
 licence_no text NOT NULL, licence_key text NOT NULL, licence_authority text NOT NULL, trn text, trn_key text, phone_e164 text NOT NULL, phone_verified_at timestamptz,
 email_canonical text NOT NULL, email_domain text NOT NULL, signup_ip_hash text, licence_document_id uuid, licence_uploaded_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenant_kyc_licence ON tenant_kyc (licence_key, lower(licence_authority));
CREATE UNIQUE INDEX tenant_kyc_trn ON tenant_kyc (trn_key) WHERE trn_key IS NOT NULL;
CREATE UNIQUE INDEX tenant_kyc_phone ON tenant_kyc (phone_e164);
CREATE UNIQUE INDEX tenant_kyc_email ON tenant_kyc (email_canonical);
CREATE INDEX tenant_kyc_name ON tenant_kyc (name_key);
CREATE INDEX tenant_kyc_domain ON tenant_kyc (email_domain);
CREATE INDEX tenant_kyc_ip ON tenant_kyc (signup_ip_hash, created_at);

CREATE TABLE email_verifications (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE phone_codes (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), code_hash text NOT NULL, expires_at timestamptz NOT NULL, attempts int NOT NULL DEFAULT 0,
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX phone_codes_tenant ON phone_codes (tenant_id, created_at DESC);
CREATE TABLE kyc_events (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor text NOT NULL, kind text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_events_tenant ON kyc_events (tenant_id, id);
CREATE TRIGGER kyc_events_immutable BEFORE UPDATE OR DELETE ON kyc_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
REVOKE ALL ON tenant_kyc, email_verifications, phone_codes, kyc_events FROM lbt_app;
