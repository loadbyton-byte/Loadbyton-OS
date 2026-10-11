-- Communications and AI: signed inbound channels, verified contact identities, append-only channel consent,
-- deterministic document extraction (reviewed before use), and template schema tracking.

CREATE TABLE inbound_channels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), kind text NOT NULL CHECK (kind IN ('email','whatsapp','telephony')),
 label text NOT NULL, token_hash text NOT NULL UNIQUE, scheme text NOT NULL CHECK (scheme IN ('lbt_hmac','meta_sha256','twilio')), secret_enc text NOT NULL, verify_token_enc text,
 sla_minutes int NOT NULL DEFAULT 240 CHECK (sla_minutes BETWEEN 1 AND 10000), thread_reply_implied boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, label)
);
CREATE TABLE inbound_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), channel_id uuid NOT NULL, provider_id text NOT NULL, sender text, sender_norm text, sender_name text,
 subject text, body text, payload_hash text NOT NULL, status text NOT NULL CHECK (status IN ('conversation','unmatched','opted_out','ignored','resolved')), conversation_id uuid, party_id uuid,
 identity_state text CHECK (identity_state IN ('verified','unverified')), received_at timestamptz NOT NULL DEFAULT now(), resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
 FOREIGN KEY (tenant_id, channel_id) REFERENCES inbound_channels(tenant_id, id), FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations(tenant_id, id),
 UNIQUE (tenant_id, channel_id, provider_id)
);
CREATE INDEX inbound_events_unmatched ON inbound_events (tenant_id, received_at) WHERE status = 'unmatched';

CREATE TABLE contact_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), party_id uuid NOT NULL, channel text NOT NULL CHECK (channel IN ('email','whatsapp','phone')),
 address text NOT NULL, verified_at timestamptz, verified_by uuid REFERENCES users(id), method text, note text, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id), UNIQUE (tenant_id, channel, address), CHECK ((verified_at IS NULL) = (verified_by IS NULL))
);
CREATE TABLE channel_consents (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), party_id uuid NOT NULL, channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms','phone')),
 status text NOT NULL CHECK (status IN ('opt_in','opt_out')), source text NOT NULL, evidence text, recorded_by uuid REFERENCES users(id), at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id), CHECK (status = 'opt_out' OR (recorded_by IS NOT NULL AND evidence IS NOT NULL))
);
CREATE INDEX channel_consents_latest ON channel_consents (tenant_id, party_id, channel, id DESC);
CREATE TRIGGER channel_consents_immutable BEFORE UPDATE OR DELETE ON channel_consents FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE conversations ADD COLUMN channel_id uuid;
ALTER TABLE conversations ADD COLUMN identity_state text NOT NULL DEFAULT 'verified' CHECK (identity_state IN ('verified','unverified'));
ALTER TABLE conversations ADD FOREIGN KEY (tenant_id, channel_id) REFERENCES inbound_channels(tenant_id, id);
ALTER TABLE conversation_messages ADD COLUMN provider_id text;

CREATE TABLE document_extractions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), document_id uuid NOT NULL, doc_sha256 text NOT NULL, extractor_version text NOT NULL,
 text_hash text NOT NULL, readable boolean NOT NULL, fields jsonb NOT NULL, warnings jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')), reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz, review_note text,
 applied_job_id uuid, applied_fields text[] NOT NULL DEFAULT '{}', created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id), FOREIGN KEY (tenant_id, applied_job_id) REFERENCES jobs(tenant_id, id),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, document_id, extractor_version, text_hash), CHECK ((status = 'proposed') = (reviewed_by IS NULL))
);

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['inbound_channels','inbound_events','contact_identities','channel_consents','document_extractions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON inbound_channels, inbound_events, contact_identities, document_extractions TO lbt_app;
GRANT SELECT,INSERT ON channel_consents TO lbt_app;
GRANT USAGE,SELECT ON SEQUENCE channel_consents_id_seq TO lbt_app;

-- Inbound message copies (sender, subject, body) are personal data: they join the retention-policy subjects.
ALTER TABLE inbound_events ADD COLUMN anonymised_at timestamptz;
ALTER TABLE privacy_retention_policies DROP CONSTRAINT privacy_retention_policies_subject_check;
ALTER TABLE privacy_retention_policies ADD CONSTRAINT privacy_retention_policies_subject_check CHECK (subject IN ('fulfil_recipient','delivery_consignee','driver_positions','inbound_messages'));

-- Assistant retrieval extends from freight to other sectors' operating records (fixed, non-personal facts only).
ALTER TABLE assistant_drafts DROP CONSTRAINT assistant_drafts_resource_check;
ALTER TABLE assistant_drafts ADD CONSTRAINT assistant_drafts_resource_check CHECK (resource IN ('enquiry','job','fulfil_order','wh_outbound','dlv_shipment','transport_order','cus_case'));
