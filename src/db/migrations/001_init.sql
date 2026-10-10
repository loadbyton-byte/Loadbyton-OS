-- LOAD|BY|TON.store — initial schema. Money = integer minor units (fils). Times = timestamptz (UTC).


DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lbt_app') THEN
    CREATE ROLE lbt_app NOLOGIN;
  END IF;
END $$;

-- ───────────── Identity (global) ─────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_staff (
  user_id      uuid PRIMARY KEY REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('commercial_admin','support','engineer','auditor')),
  totp_secret  text NOT NULL,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  tenant_id    uuid,
  csrf         text NOT NULL,
  mfa_ok       boolean NOT NULL DEFAULT false,
  support_tenant_id uuid,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  country     text NOT NULL DEFAULT 'AE',
  emirate     text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  goal        text,
  timezone    text NOT NULL DEFAULT 'Asia/Dubai',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  roles      text[] NOT NULL,
  party_id   uuid,                         -- portal users are bound to one party
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       text NOT NULL,
  roles       text[] NOT NULL,
  party_id    uuid,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  legal_name text,
  tax_id     text,
  currency   text NOT NULL DEFAULT 'AED',
  invoice_prefix text NOT NULL DEFAULT 'INV',
  margin_threshold_bps int NOT NULL DEFAULT 1000,   -- quotes below this margin need approval
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  entity_id  uuid NOT NULL,
  name       text NOT NULL,
  city       text,
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id)
);

CREATE TABLE tenant_sectors (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sector    text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sector)
);

-- ───────────── Platform: catalog, billing, entitlements ─────────────
CREATE TABLE plan_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code     text NOT NULL,
  version       int  NOT NULL,
  name          text NOT NULL,
  monthly_minor int  NOT NULL,
  setup_minor   int  NOT NULL,
  currency      text NOT NULL DEFAULT 'AED',
  limits        jsonb NOT NULL,           -- {max_users, max_branches, jobs_per_month, storage_mb, max_sectors, max_entities}
  contact_sales boolean NOT NULL DEFAULT false,
  published_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_code, version)
);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on % is not permitted (immutable record)', TG_OP, TG_TABLE_NAME; END $$;

CREATE TRIGGER plan_versions_immutable BEFORE UPDATE OR DELETE ON plan_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL UNIQUE REFERENCES tenants(id),
  plan_version_id  uuid NOT NULL REFERENCES plan_versions(id),
  status           text NOT NULL CHECK (status IN ('active','grace','restricted','cancelled')),
  period_start     timestamptz NOT NULL DEFAULT now(),
  period_end       timestamptz,                -- null = free forever
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  scheduled_plan_version_id uuid REFERENCES plan_versions(id),
  grace_until      timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  plan_version_id  uuid NOT NULL REFERENCES plan_versions(id),
  lines            jsonb NOT NULL,             -- immutable priced lines at order time
  currency         text NOT NULL,
  subtotal_minor   int NOT NULL,
  tax_minor        int NOT NULL,
  total_minor      int NOT NULL,
  tax_note         text NOT NULL,
  reference        text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded','cancelled')),
  provider         text NOT NULL,
  provider_session text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz
);

CREATE TABLE payment_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  event_id    text NOT NULL,
  type        text NOT NULL,
  order_id    uuid REFERENCES orders(id),
  payload     jsonb NOT NULL,
  outcome     text NOT NULL,                -- applied | duplicate | ignored | rejected
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE entitlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  key              text NOT NULL,
  int_limit        int NOT NULL,
  plan_version_id  uuid REFERENCES plan_versions(id),
  effective_from   timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL
);
CREATE INDEX entitlements_lookup ON entitlements (tenant_id, key, effective_from DESC);

CREATE TABLE usage_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key       text NOT NULL,
  period    text NOT NULL,                   -- YYYY-MM or 'all'
  used      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, key, period)
);

CREATE TABLE usage_events (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key       text NOT NULL,
  qty       int NOT NULL,
  ref       text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, ref)
);
CREATE TRIGGER usage_events_immutable BEFORE UPDATE OR DELETE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE provision_jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL UNIQUE REFERENCES orders(id),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  state      text NOT NULL DEFAULT 'queued'
             CHECK (state IN ('queued','information_pending','provisioning','validation','ready','onboarding','failed','cancelled')),
  failure_reason text,
  owner_action   text,
  attempts   int NOT NULL DEFAULT 0,
  queued_at  timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ready_at   timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provision_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES provision_jobs(id),
  step            text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN ('done','failed')),
  detail          jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE domain_mappings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  hostname    text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('standard','custom')),
  status      text NOT NULL CHECK (status IN ('pending_verification','verified','removed')),
  verify_token text NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- a hostname belongs to exactly one live mapping
CREATE UNIQUE INDEX domain_live_unique ON domain_mappings (hostname) WHERE status <> 'removed';

CREATE TABLE support_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  staff_user_id uuid NOT NULL REFERENCES users(id),
  reason      text NOT NULL,
  status      text NOT NULL CHECK (status IN ('requested','approved','revoked','denied')),
  expires_at  timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz
);

CREATE TABLE platform_leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  company    text,
  email      text NOT NULL,
  message    text,
  sectors    text[],
  source     text NOT NULL DEFAULT 'contact',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Operating plane (tenant scoped, RLS) ─────────────
CREATE TABLE parties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  kind          text NOT NULL CHECK (kind IN ('customer','supplier','agent')),
  name          text NOT NULL,
  email         text,
  phone         text,
  tax_id        text,
  credit_limit_minor bigint NOT NULL DEFAULT 0,
  consent_marketing boolean NOT NULL DEFAULT false,
  owner_user_id uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX parties_name_unique ON parties (tenant_id, kind, lower(name));

CREATE TABLE counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name      text NOT NULL,
  value     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE enquiries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  party_id      uuid,
  source        text NOT NULL DEFAULT 'manual',
  external_ref  text,
  dedupe_key    text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('air','ocean','road')),
  trade         text NOT NULL DEFAULT 'import' CHECK (trade IN ('import','export','cross_trade')),
  origin        text,
  destination   text,
  cargo_desc    text,
  pieces        int,
  weight_kg     numeric(12,3),
  volume_cbm    numeric(12,3),
  ready_date    date,
  incoterm      text,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','qualified','quoted','won','lost')),
  lost_reason   text,
  assigned_to   uuid REFERENCES users(id),
  missing_info  text[] NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no),
  UNIQUE (tenant_id, dedupe_key)
);

CREATE TABLE rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  supplier_id   uuid,
  mode          text NOT NULL,
  origin        text NOT NULL,
  destination   text NOT NULL,
  charge_name   text NOT NULL,
  basis         text NOT NULL CHECK (basis IN ('per_kg','per_cbm','per_shipment','per_container')),
  unit_cost_minor bigint NOT NULL,
  minimum_minor bigint NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'AED',
  valid_from    date NOT NULL,
  valid_to      date NOT NULL,
  exclusions    text,
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id)
);

CREATE TABLE quotes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  enquiry_id    uuid,
  party_id      uuid NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','pending_approval','approved','sent','accepted','rejected','expired','converted')),
  current_version int NOT NULL DEFAULT 1,
  approval_reason text,
  approved_by   uuid REFERENCES users(id),
  accepted_at   timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, enquiry_id) REFERENCES enquiries(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE quote_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  quote_id    uuid NOT NULL,
  version     int NOT NULL,
  currency    text NOT NULL DEFAULT 'AED',
  valid_until date NOT NULL,
  exclusions  text,
  terms       text,
  total_sell_minor bigint NOT NULL DEFAULT 0,
  total_cost_minor bigint NOT NULL DEFAULT 0,
  locked      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (quote_id, version)
);

CREATE TABLE quote_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  version_id  uuid NOT NULL,
  position    int NOT NULL,
  description text NOT NULL,
  supplier_id uuid,
  qty         numeric(12,3) NOT NULL DEFAULT 1,
  unit_sell_minor bigint NOT NULL,
  unit_cost_minor bigint NOT NULL DEFAULT 0,
  tax_code    text NOT NULL DEFAULT 'SR5',
  rate_id     uuid REFERENCES rates(id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES quote_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id)
);

-- locked quote versions (and their lines) are historical records
CREATE FUNCTION guard_locked_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked_flag boolean; vid uuid;
BEGIN
  IF TG_TABLE_NAME = 'quote_versions' THEN
    IF TG_OP = 'DELETE' THEN locked_flag := OLD.locked; ELSE locked_flag := OLD.locked; END IF;
    -- allow the single transition unlocked -> locked
    IF TG_OP = 'UPDATE' AND OLD.locked = false THEN RETURN NEW; END IF;
    IF locked_flag THEN RAISE EXCEPTION 'quote version % is locked', OLD.id; END IF;
    RETURN COALESCE(NEW, OLD);
  ELSE
    vid := COALESCE(NEW.version_id, OLD.version_id);
    SELECT locked INTO locked_flag FROM quote_versions WHERE id = vid;
    IF locked_flag THEN RAISE EXCEPTION 'quote version % is locked', vid; END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
END $$;
CREATE TRIGGER quote_versions_guard BEFORE UPDATE OR DELETE ON quote_versions
  FOR EACH ROW EXECUTE FUNCTION guard_locked_quote();
CREATE TRIGGER quote_lines_guard BEFORE UPDATE OR DELETE ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION guard_locked_quote();

CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  entity_id     uuid NOT NULL,
  no            text NOT NULL,
  quote_id      uuid UNIQUE,                 -- one job per accepted quote
  quote_version_id uuid,
  party_id      uuid NOT NULL,
  mode          text NOT NULL,
  incoterm      text,
  origin        text,
  destination   text,
  pieces        int,
  weight_kg     numeric(12,3),
  volume_cbm    numeric(12,3),
  booking_ref   text,
  master_ref    text,
  house_ref     text,
  carrier       text,
  status        text NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','in_transit','delivered','operationally_complete','cancelled')),
  financial_status text NOT NULL DEFAULT 'open'
                CHECK (financial_status IN ('open','invoiced','collected','closed')),
  assigned_to   uuid REFERENCES users(id),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE job_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  job_id      uuid NOT NULL,
  description text NOT NULL,
  qty         numeric(12,3) NOT NULL DEFAULT 1,
  unit_minor  bigint NOT NULL,
  tax_code    text NOT NULL DEFAULT 'SR5',
  approved    boolean NOT NULL DEFAULT true,
  invoice_id  uuid,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);

CREATE TABLE job_costs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  job_id         uuid NOT NULL,
  supplier_id    uuid,
  description    text NOT NULL,
  estimated_minor bigint NOT NULL DEFAULT 0,
  actual_minor   bigint,                     -- null until supplier invoice reconciled
  supplier_invoice_ref text,
  status         text NOT NULL DEFAULT 'estimated' CHECK (status IN ('estimated','invoiced','posted')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id)
);

CREATE TABLE job_milestones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  job_id      uuid NOT NULL,
  code        text NOT NULL,
  label       text NOT NULL,
  position    int NOT NULL,
  planned_at  timestamptz,
  actual_at   timestamptz,
  note        text,
  recorded_by uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);

CREATE TABLE job_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  job_id      uuid,
  title       text NOT NULL,
  detail      text,
  owner_id    uuid REFERENCES users(id),
  due_at      timestamptz NOT NULL,
  escalate_to uuid REFERENCES users(id),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  job_id      uuid,
  kind        text NOT NULL,
  title       text NOT NULL,
  version     int NOT NULL DEFAULT 1,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  issuer      text,                          -- who issued/approved it (authoritative documents are issued externally)
  customer_visible boolean NOT NULL DEFAULT false,
  storage_key text NOT NULL,
  filename    text NOT NULL,
  mime        text NOT NULL,
  size_bytes  int NOT NULL,
  sha256      text NOT NULL,
  hold        boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id)
);

CREATE TABLE invoices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  entity_id   uuid NOT NULL,
  no          text NOT NULL,
  party_id    uuid NOT NULL,
  job_id      uuid,
  status      text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','part_paid','paid','void')),
  currency    text NOT NULL DEFAULT 'AED',
  subtotal_minor bigint NOT NULL,
  tax_minor   bigint NOT NULL,
  total_minor bigint NOT NULL,
  paid_minor  bigint NOT NULL DEFAULT 0,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz NOT NULL,
  external_id text,
  sync_status text NOT NULL DEFAULT 'not_connected' CHECK (sync_status IN ('not_connected','pending','synced','failed')),
  created_by  uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, entity_id) REFERENCES entities(tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no)
);

CREATE TABLE invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  invoice_id  uuid NOT NULL,
  description text NOT NULL,
  qty         numeric(12,3) NOT NULL,
  unit_minor  bigint NOT NULL,
  tax_code    text NOT NULL,
  net_minor   bigint NOT NULL,
  tax_minor   bigint NOT NULL,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);

CREATE TABLE receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  invoice_id  uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  received_at date NOT NULL,
  method      text NOT NULL,
  reference   text,
  recorded_by uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);

CREATE TABLE accounting_connections (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id),
  provider    text NOT NULL,
  status      text NOT NULL CHECK (status IN ('requested','available','connected','validating','live','degraded','disconnected')),
  config      jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES tenants(id),
  topic       text NOT NULL,
  key         text NOT NULL UNIQUE,          -- idempotency: a retry never creates a second effect
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  external_id text,
  next_at     timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid,
  actor_user_id uuid,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('user','system','platform_staff','support_grant')),
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  data        jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────────── Row-level security ─────────────
-- Tenant identity comes from the authenticated membership and is set per transaction (app.tenant_id).
-- The runtime role lbt_app has no BYPASSRLS and is not the table owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'entities','branches','tenant_sectors','memberships','invitations','subscriptions','orders','entitlements',
    'usage_counters','usage_events','domain_mappings','support_grants',
    'parties','counters','enquiries','rates','quotes','quote_versions','quote_lines','jobs','job_charges',
    'job_costs','job_milestones','job_exceptions','documents','invoices','invoice_lines','receipts',
    'accounting_connections','outbox','audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- tenants row: a tenant may see only itself
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- plan catalog is readable by everyone, writable by no tenant context
GRANT SELECT ON plan_versions TO lbt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  entities, branches, tenant_sectors, memberships, invitations, subscriptions, orders, entitlements,
  usage_counters, usage_events, domain_mappings, support_grants, parties, counters, enquiries, rates,
  quotes, quote_versions, quote_lines, jobs, job_charges, job_costs, job_milestones, job_exceptions,
  documents, invoices, invoice_lines, receipts, accounting_connections, outbox TO lbt_app;
GRANT SELECT, INSERT ON audit_log TO lbt_app;
GRANT SELECT ON tenants TO lbt_app;
-- team listing without exposing the global users table (or password hashes) to tenant context
CREATE VIEW team_members AS
  SELECT m.tenant_id, m.user_id, u.email, u.name, m.roles, m.party_id, m.active
  FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
GRANT SELECT ON team_members TO lbt_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO lbt_app;
