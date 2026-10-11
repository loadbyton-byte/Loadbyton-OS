-- Scheduled data minimisation (retention policies), legal holds and a two-person tenant erasure plan.
ALTER TABLE fulfil_orders ADD COLUMN anonymised_at timestamptz;
ALTER TABLE dlv_shipments ADD COLUMN anonymised_at timestamptz;

CREATE TABLE privacy_retention_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 subject text NOT NULL CHECK (subject IN ('fulfil_recipient','delivery_consignee')),
 retain_days int NOT NULL CHECK (retain_days BETWEEN 30 AND 3650),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
 reason text NOT NULL, approved_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, subject)
);
CREATE TABLE privacy_legal_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), party_id uuid,
 reason text NOT NULL, placed_by uuid NOT NULL REFERENCES users(id), placed_at timestamptz NOT NULL DEFAULT now(),
 released_by uuid REFERENCES users(id), released_at timestamptz, release_reason text,
 FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id), UNIQUE (tenant_id, id),
 CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX privacy_legal_holds_open ON privacy_legal_holds (tenant_id) WHERE released_at IS NULL;
CREATE TABLE privacy_minimisation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), policy_id uuid NOT NULL,
 subject text NOT NULL, retain_days int NOT NULL, rows_anonymised int NOT NULL CHECK (rows_anonymised > 0),
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (tenant_id, policy_id) REFERENCES privacy_retention_policies(tenant_id, id)
);
CREATE TRIGGER privacy_minimisation_runs_immutable BEFORE UPDATE OR DELETE ON privacy_minimisation_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE FUNCTION privacy_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.tenant_id,NEW.party_id,NEW.reason,NEW.placed_by,NEW.placed_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.party_id,OLD.reason,OLD.placed_by,OLD.placed_at) OR (OLD.released_at IS NOT NULL)
 THEN RAISE EXCEPTION 'legal hold evidence is immutable; only a single release is permitted'; END IF; RETURN NEW; END $$;
CREATE TRIGGER privacy_hold_guard BEFORE UPDATE OR DELETE ON privacy_legal_holds FOR EACH ROW EXECUTE FUNCTION privacy_hold_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['privacy_retention_policies','privacy_legal_holds','privacy_minimisation_runs'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON privacy_retention_policies, privacy_legal_holds TO lbt_app;
GRANT SELECT,INSERT ON privacy_minimisation_runs TO lbt_app;

-- Platform-staff controlled; not visible to tenant roles.
CREATE TABLE privacy_erasure_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE REFERENCES data_requests(id), tenant_id uuid NOT NULL REFERENCES tenants(id),
 plan jsonb NOT NULL, prepared_by uuid NOT NULL REFERENCES users(id), prepared_at timestamptz NOT NULL DEFAULT now(),
 approved_by uuid REFERENCES users(id), approved_at timestamptz, executed_at timestamptz, result jsonb,
 CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);
