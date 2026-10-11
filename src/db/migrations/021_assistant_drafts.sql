CREATE TABLE assistant_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), reference uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), resource text NOT NULL CHECK(resource IN ('enquiry','job')), source_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('summary','reply','classification')), template_version int NOT NULL DEFAULT 1 CHECK(template_version=1),
 source_snapshot jsonb NOT NULL, source_hash text NOT NULL, provider text NOT NULL CHECK(provider IN ('deterministic','openai')),
 model text NOT NULL, pricing jsonb NOT NULL, period text NOT NULL, reserved_micro_usd bigint NOT NULL CHECK(reserved_micro_usd>=0),
 status text NOT NULL DEFAULT 'generating' CHECK(status IN ('generating','draft')), output jsonb,
 cost_micro_usd bigint CHECK(cost_micro_usd>=0 AND cost_micro_usd<=reserved_micro_usd),
 prompt_tokens int, completion_tokens int, cost_status text CHECK(cost_status IN ('no_charge','measured','uncertain')),
 fallback_reason text CHECK(fallback_reason IN ('disabled','provider_unavailable','invalid_output','interrupted')),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,created_by,reference),
 CHECK((status='generating' AND output IS NULL AND completed_at IS NULL AND cost_micro_usd IS NULL) OR
 (status='draft' AND output IS NOT NULL AND completed_at IS NOT NULL AND cost_micro_usd IS NOT NULL AND cost_status IS NOT NULL)),
 CHECK((purpose='classification' AND resource='enquiry') OR purpose IN ('summary','reply'))
);
CREATE INDEX assistant_budget_period ON assistant_drafts(tenant_id,period);
CREATE FUNCTION assistant_draft_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'assistant evidence is immutable'; END IF;
 IF OLD.status<>'generating' OR NEW.status<>'draft' OR
 (NEW.id,NEW.tenant_id,NEW.reference,NEW.created_by,NEW.resource,NEW.source_id,NEW.purpose,NEW.template_version,NEW.source_snapshot,NEW.source_hash,NEW.provider,NEW.model,NEW.pricing,NEW.period,NEW.reserved_micro_usd,NEW.created_at) IS DISTINCT FROM
 (OLD.id,OLD.tenant_id,OLD.reference,OLD.created_by,OLD.resource,OLD.source_id,OLD.purpose,OLD.template_version,OLD.source_snapshot,OLD.source_hash,OLD.provider,OLD.model,OLD.pricing,OLD.period,OLD.reserved_micro_usd,OLD.created_at)
 THEN RAISE EXCEPTION 'assistant draft evidence is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER assistant_evidence_immutable BEFORE UPDATE OR DELETE ON assistant_drafts FOR EACH ROW EXECUTE FUNCTION assistant_draft_immutable();
ALTER TABLE assistant_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assistant_drafts USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON assistant_drafts TO lbt_app;
