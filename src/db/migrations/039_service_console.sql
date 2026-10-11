-- Service console: reconciled stock/opening-balance migration with final-delta, partner commission/refund ledger, rollout cohorts.
CREATE TABLE stock_migrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), module text NOT NULL CHECK (module IN ('fulfilment','custody')),
 purpose text NOT NULL, source_document_id uuid NOT NULL, source_hash text NOT NULL, control_units numeric(14,3) NOT NULL CHECK (control_units >= 0),
 targets jsonb NOT NULL, diff jsonb NOT NULL, summary jsonb NOT NULL,
 status text NOT NULL DEFAULT 'validated' CHECK (status IN ('validated','applied','rolled_back','superseded')),
 approved_by uuid REFERENCES users(id), evidence text, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz,
 FOREIGN KEY (tenant_id, source_document_id) REFERENCES documents(tenant_id, id), UNIQUE (tenant_id, id)
);
ALTER TABLE stock_migrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_migrations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON stock_migrations TO lbt_app;

-- Platform-owned (no tenant RLS): reached only through staff routes and the payment webhook path.
CREATE TABLE partners (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text, commission_bps int NOT NULL CHECK (commission_bps BETWEEN 0 AND 5000),
 commission_months int NOT NULL CHECK (commission_months BETWEEN 1 AND 36), agreement_ref text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partners_name_unique ON partners (lower(name));
CREATE TABLE partner_referrals (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), partner_id uuid NOT NULL REFERENCES partners(id), evidence text NOT NULL,
 recorded_by uuid NOT NULL REFERENCES users(id), referred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE partner_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid NOT NULL REFERENCES partners(id), tenant_id uuid REFERENCES tenants(id), order_id uuid REFERENCES orders(id),
 kind text NOT NULL CHECK (kind IN ('commission','reversal','payout')), currency text NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor <> 0), basis_minor bigint,
 source_key text NOT NULL UNIQUE, note text, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((kind = 'commission' AND amount_minor > 0) OR (kind IN ('reversal','payout') AND amount_minor < 0))
);
CREATE INDEX partner_ledger_balance ON partner_ledger (partner_id, currency);
CREATE TRIGGER partner_ledger_immutable BEFORE UPDATE OR DELETE ON partner_ledger FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER partner_referrals_immutable BEFORE UPDATE OR DELETE ON partner_referrals FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TABLE partner_payouts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid NOT NULL REFERENCES partners(id), currency text NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 reference text, status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')), requested_by uuid NOT NULL REFERENCES users(id), requested_at timestamptz NOT NULL DEFAULT now(),
 decided_by uuid REFERENCES users(id), decided_at timestamptz, CHECK ((status = 'requested') = (decided_by IS NULL)), CHECK (status <> 'paid' OR reference IS NOT NULL)
);

CREATE TABLE rollout_cohorts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rollout_cohorts_name_unique ON rollout_cohorts (lower(name));
CREATE TABLE rollout_cohort_tenants (cohort_id uuid NOT NULL REFERENCES rollout_cohorts(id), tenant_id uuid NOT NULL REFERENCES tenants(id), added_by uuid NOT NULL REFERENCES users(id), added_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (cohort_id, tenant_id));
CREATE TABLE rollout_flags (
 key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]{2,60}$'), audience text NOT NULL DEFAULT 'off' CHECK (audience IN ('off','cohorts','all')), note text,
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rollout_flag_cohorts (key text NOT NULL REFERENCES rollout_flags(key) ON DELETE CASCADE, cohort_id uuid NOT NULL REFERENCES rollout_cohorts(id), PRIMARY KEY (key, cohort_id));
