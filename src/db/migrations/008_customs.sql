-- LOAD|BY|TON Customs (brokerage case management). This is a WORKING RECORD and a controlled HANDOVER, not a filing system:
-- the declaration itself is lodged by a licensed broker in the official channel (Dubai Trade / Mirsal 2 …) which this software does not access.
-- What is enforced here: evidence checklist before review, independent approval (maker ≠ checker), a submission that records the official
-- declaration number once, assessment vs estimate, inspections and queries that block release, duty paid before release, and client
-- money (deposits / guarantees) that can never be over-applied.

-- a checklist item points at the evidence document with a composite key, so evidence can never come from another tenant
ALTER TABLE documents ADD CONSTRAINT documents_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE cus_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  no            text NOT NULL,
  party_id      uuid NOT NULL,                              -- the importer / exporter (our customer)
  job_id        uuid,                                       -- optional freight job this clearance belongs to
  direction     text NOT NULL CHECK (direction IN ('import','export','re_export','transit')),
  mode          text NOT NULL CHECK (mode IN ('sea','air','road')),
  customs_office text,
  origin_country      text CHECK (origin_country IS NULL OR origin_country ~ '^[A-Z]{2}$'),
  destination_country text CHECK (destination_country IS NULL OR destination_country ~ '^[A-Z]{2}$'),
  incoterm      text,
  currency      text NOT NULL DEFAULT 'AED' CHECK (currency ~ '^[A-Z]{3}$'),
  fx_rate       numeric(14,6) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),           -- case currency → AED, as entered by the broker (the official rate prevails)
  freight_minor   bigint NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),          -- case currency; allocated to lines pro rata by value
  insurance_minor bigint NOT NULL DEFAULT 0 CHECK (insurance_minor >= 0),
  other_minor     bigint NOT NULL DEFAULT 0 CHECK (other_minor >= 0),
  transport_ref text,                                        -- B/L, AWB or CMR number
  container_nos text,
  vessel_flight text,
  eta           date,
  status        text NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','in_review','approved','submitted','assessed','inspection','released','rejected','closed','cancelled')),
  reopen_count  int NOT NULL DEFAULT 0,
  prepared_by   uuid REFERENCES users(id),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  estimated_duty_minor bigint,                               -- AED, snapshot at approval
  estimated_vat_minor  bigint,
  channel       text CHECK (channel IN ('dubai_trade','mirsal2','other')),
  declaration_no text,
  submitted_by  uuid REFERENCES users(id),
  submitted_at  timestamptz,
  assessed_duty_minor bigint CHECK (assessed_duty_minor IS NULL OR assessed_duty_minor >= 0),   -- AED, as assessed by customs
  assessed_vat_minor  bigint CHECK (assessed_vat_minor IS NULL OR assessed_vat_minor >= 0),
  assessed_at   timestamptz,
  release_ref   text,
  released_at   timestamptz,
  released_by   uuid REFERENCES users(id),
  rejection_reason text,
  closed_at     timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, no),
  UNIQUE (tenant_id, channel, declaration_no),                -- one official declaration number belongs to one case
  CHECK (status NOT IN ('approved','submitted','assessed','inspection','released','closed') OR approved_by IS NOT NULL),
  CHECK (status NOT IN ('submitted','assessed','inspection','released','closed') OR (declaration_no IS NOT NULL AND channel IS NOT NULL AND submitted_at IS NOT NULL)),
  CHECK (status NOT IN ('released','closed') OR (released_at IS NOT NULL AND assessed_duty_minor IS NOT NULL AND assessed_vat_minor IS NOT NULL) OR status = 'closed')
);
CREATE INDEX cus_cases_status ON cus_cases(tenant_id, status);

CREATE TABLE cus_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  case_id     uuid NOT NULL,
  line_no     int NOT NULL CHECK (line_no > 0),
  description text NOT NULL,
  hs_code     text NOT NULL CHECK (hs_code ~ '^[0-9]{6,12}$'),   -- as the broker classifies it; format-checked only, never "advised"
  origin_country text CHECK (origin_country IS NULL OR origin_country ~ '^[A-Z]{2}$'),
  qty         numeric(14,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  uom         text NOT NULL DEFAULT 'unit',
  net_kg      numeric(14,3) NOT NULL DEFAULT 0 CHECK (net_kg >= 0),
  gross_kg    numeric(14,3) NOT NULL DEFAULT 0 CHECK (gross_kg >= net_kg),
  value_minor bigint NOT NULL CHECK (value_minor > 0),            -- invoice value in the case currency
  duty_rate_bps int NOT NULL DEFAULT 0 CHECK (duty_rate_bps BETWEEN 0 AND 10000),   -- entered by the broker; there is no built-in tariff
  vat_rate_bps  int NOT NULL DEFAULT 500 CHECK (vat_rate_bps BETWEEN 0 AND 2500),
  restricted  boolean NOT NULL DEFAULT false,                     -- needs a permit / NOC / specialist handling
  restriction_note text,
  alloc_minor   bigint NOT NULL DEFAULT 0,                        -- share of freight+insurance+other (case currency)
  cif_aed_minor bigint NOT NULL DEFAULT 0,
  duty_minor    bigint NOT NULL DEFAULT 0,                        -- estimate, AED
  vat_minor     bigint NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, case_id) REFERENCES cus_cases(tenant_id, id) ON DELETE CASCADE,
  CHECK (NOT restricted OR restriction_note IS NOT NULL),
  UNIQUE (tenant_id, case_id, line_no)
);

CREATE TABLE cus_checklist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  case_id     uuid NOT NULL,
  kind        text NOT NULL,
  label       text NOT NULL,
  mandatory   boolean NOT NULL DEFAULT true,
  source      text NOT NULL DEFAULT 'template' CHECK (source IN ('template','manual','restricted_goods')),
  status      text NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','received','waived')),
  document_id uuid,
  note        text,
  waived_reason text,
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  FOREIGN KEY (tenant_id, case_id) REFERENCES cus_cases(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id),
  CHECK (status <> 'received' OR document_id IS NOT NULL OR note IS NOT NULL),
  CHECK (status <> 'waived' OR (waived_reason IS NOT NULL AND decided_by IS NOT NULL)),
  UNIQUE (tenant_id, id)
);

CREATE TABLE cus_inspections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  case_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('document','physical','scanner','lab')),
  location    text,
  requested_on date NOT NULL,
  result      text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','passed','passed_with_conditions','failed')),
  findings    text,
  closed_at   timestamptz,
  recorded_by uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cus_cases(tenant_id, id),
  CHECK (result = 'pending' OR (closed_at IS NOT NULL AND findings IS NOT NULL))
);

CREATE TABLE cus_queries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  case_id     uuid NOT NULL,
  raised_on   date NOT NULL,
  text        text NOT NULL,
  due_on      date,
  answered_at timestamptz,
  answer      text,
  raised_by   uuid REFERENCES users(id),
  answered_by uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cus_cases(tenant_id, id),
  CHECK ((answered_at IS NULL) = (answer IS NULL))
);

CREATE TABLE cus_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  case_id    uuid NOT NULL,
  kind       text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cus_cases(tenant_id, id)
);
CREATE TRIGGER cus_events_immutable BEFORE UPDATE OR DELETE ON cus_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ── client money: deposits and bank guarantees held for a customer, applied to duty payments
CREATE TABLE cus_deposits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  party_id    uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('cash_deposit','bank_guarantee')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reference   text NOT NULL,
  received_on date NOT NULL,
  expires_on  date,
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id),
  UNIQUE (tenant_id, id),
  CHECK (refunded_minor <= amount_minor)
);

CREATE TABLE cus_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  case_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('duty','vat','fine','refund')),     -- amounts paid to / refunded by customs, AED
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  method      text NOT NULL CHECK (method IN ('deposit','bank','card','cash')),
  deposit_id  uuid,
  reference   text NOT NULL,
  paid_on     date NOT NULL,
  idem_key    text,
  recorded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cus_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, deposit_id) REFERENCES cus_deposits(tenant_id, id),
  CHECK ((method = 'deposit') = (deposit_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idem_key)
);
CREATE TRIGGER cus_payments_immutable BEFORE UPDATE OR DELETE ON cus_payments FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- every payment made from a deposit consumes it exactly once (one application per such payment)
CREATE TABLE cus_deposit_apps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  deposit_id  uuid NOT NULL,
  payment_id  uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, deposit_id) REFERENCES cus_deposits(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES cus_payments(tenant_id, id),
  UNIQUE (tenant_id, payment_id)
);
CREATE TRIGGER cus_deposit_apps_immutable BEFORE UPDATE OR DELETE ON cus_deposit_apps FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ── billing: broker fees and duty disbursements recovered from the customer
CREATE TABLE cus_charges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  case_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('broker_fee','duty','vat','disbursement','other')),
  description text NOT NULL,
  qty         numeric(12,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_minor  bigint NOT NULL CHECK (unit_minor >= 0),
  tax_code    text NOT NULL DEFAULT 'SR5',
  source_ref  text,                                            -- a duty/VAT disbursement is created once per payment
  invoice_id  uuid,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES cus_cases(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  UNIQUE (tenant_id, source_ref)
);

ALTER TABLE invoices ADD COLUMN cus_case_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY (tenant_id, cus_case_id) REFERENCES cus_cases(tenant_id, id);
ALTER TABLE documents ADD COLUMN cus_case_id uuid;
ALTER TABLE documents ADD FOREIGN KEY (tenant_id, cus_case_id) REFERENCES cus_cases(tenant_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cus_cases','cus_lines','cus_checklist','cus_inspections','cus_queries','cus_events','cus_deposits','cus_payments','cus_deposit_apps','cus_charges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON cus_cases, cus_lines, cus_checklist, cus_inspections, cus_queries, cus_deposits, cus_charges TO lbt_app;
GRANT SELECT, INSERT ON cus_events, cus_payments, cus_deposit_apps TO lbt_app;
