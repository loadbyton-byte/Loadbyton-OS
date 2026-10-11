-- Freight commercial depth: opportunities/tenders, rate tiers, supplier contract restrictions, master/house shipments.

-- ── Opportunities and tenders
CREATE TABLE opportunities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), no text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('tender','rfq','spot','renewal')), party_id uuid NOT NULL, title text NOT NULL, source_ref text,
 currency text NOT NULL DEFAULT 'AED', est_value_minor bigint NOT NULL DEFAULT 0 CHECK (est_value_minor >= 0),
 win_pct int NOT NULL DEFAULT 20 CHECK (win_pct BETWEEN 0 AND 100),
 clarification_by date, submission_by date, decision_expected date,
 stage text NOT NULL DEFAULT 'identified' CHECK (stage IN ('identified','bid_review','bidding','submitted','won','lost','no_bid','withdrawn')),
 bid_decision_by uuid REFERENCES users(id), bid_decision_note text, outcome_note text, lost_reason text, competitor_note text,
 owner_id uuid REFERENCES users(id), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, no),
 CHECK (stage NOT IN ('won','lost','no_bid','withdrawn') OR closed_at IS NOT NULL)
);
CREATE TABLE opportunity_lanes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), opportunity_id uuid NOT NULL,
 mode text NOT NULL CHECK (mode IN ('air','ocean','road')), origin text NOT NULL, destination text NOT NULL,
 volume numeric(14,3) NOT NULL DEFAULT 0 CHECK (volume >= 0), unit text NOT NULL DEFAULT 'shipments' CHECK (unit IN ('shipments','kg','cbm','teu')), period text NOT NULL DEFAULT 'year' CHECK (period IN ('month','year','once')),
 FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id)
);
CREATE TABLE opportunity_quotes (
 tenant_id uuid NOT NULL REFERENCES tenants(id), opportunity_id uuid NOT NULL, quote_id uuid NOT NULL, linked_by uuid NOT NULL REFERENCES users(id), linked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (opportunity_id, quote_id), FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id), FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, id)
);
CREATE TABLE opportunity_events (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), opportunity_id uuid NOT NULL, from_stage text, to_stage text NOT NULL, note text, actor_id uuid NOT NULL REFERENCES users(id), at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities(tenant_id, id)
);
CREATE TRIGGER opportunity_events_immutable BEFORE UPDATE OR DELETE ON opportunity_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ── Rate tiers (quantity breaks). Applied to the whole quantity at the highest break reached.
CREATE TABLE rate_tiers (
 tenant_id uuid NOT NULL REFERENCES tenants(id), rate_id uuid NOT NULL REFERENCES rates(id), from_qty numeric(14,3) NOT NULL CHECK (from_qty >= 0), unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (rate_id, from_qty)
);
CREATE TRIGGER rate_tiers_immutable BEFORE UPDATE OR DELETE ON rate_tiers FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ── Supplier contract restrictions
CREATE TABLE supplier_contracts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), supplier_id uuid NOT NULL, reference text NOT NULL,
 valid_from date NOT NULL, valid_to date NOT NULL CHECK (valid_to >= valid_from), modes text[] NOT NULL DEFAULT '{}', origins text[] NOT NULL DEFAULT '{}', destinations text[] NOT NULL DEFAULT '{}',
 max_cost_minor bigint CHECK (max_cost_minor IS NULL OR max_cost_minor > 0), terms text, document_id uuid,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','ended')), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id), FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, supplier_id, reference)
);
CREATE TABLE supplier_policy (
 tenant_id uuid NOT NULL REFERENCES tenants(id), supplier_id uuid NOT NULL, contract_required boolean NOT NULL DEFAULT false, blocked boolean NOT NULL DEFAULT false, blocked_reason text,
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, supplier_id), FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id),
 CHECK (NOT blocked OR blocked_reason IS NOT NULL)
);
ALTER TABLE job_costs ADD COLUMN contract_override text;

-- ── Master / house shipments. A house shipment is a job; the master is the carrier-level document that carries many.
CREATE TABLE freight_masters (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), no text NOT NULL, mode text NOT NULL CHECK (mode IN ('air','ocean','road')),
 master_ref text NOT NULL, carrier text, origin text NOT NULL, destination text NOT NULL, vessel_or_flight text, etd date, eta date,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, no)
);
CREATE UNIQUE INDEX freight_masters_ref_unique ON freight_masters (tenant_id, mode, lower(master_ref)) WHERE status <> 'cancelled';
ALTER TABLE jobs ADD COLUMN master_id uuid;
ALTER TABLE jobs ADD FOREIGN KEY (tenant_id, master_id) REFERENCES freight_masters(tenant_id, id);
CREATE UNIQUE INDEX jobs_house_ref_unique ON jobs (tenant_id, master_id, lower(house_ref)) WHERE master_id IS NOT NULL AND house_ref IS NOT NULL;
CREATE TABLE freight_master_costs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), master_id uuid NOT NULL, supplier_id uuid, description text NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0), basis text CHECK (basis IN ('chargeable_weight','weight','volume','pieces','equal')),
 allocated_at timestamptz, allocated_by uuid REFERENCES users(id), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, master_id) REFERENCES freight_masters(tenant_id, id), FOREIGN KEY (tenant_id, supplier_id) REFERENCES parties(tenant_id, id), UNIQUE (tenant_id, id),
 CHECK ((allocated_at IS NULL) = (basis IS NULL))
);
CREATE TABLE freight_master_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), master_cost_id uuid NOT NULL, job_id uuid NOT NULL, job_cost_id uuid NOT NULL,
 basis_value numeric(14,3) NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
 FOREIGN KEY (tenant_id, master_cost_id) REFERENCES freight_master_costs(tenant_id, id), FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id), UNIQUE (master_cost_id, job_id)
);
CREATE TRIGGER freight_master_allocations_immutable BEFORE UPDATE OR DELETE ON freight_master_allocations FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['opportunities','opportunity_lanes','opportunity_quotes','opportunity_events','rate_tiers','supplier_contracts','supplier_policy','freight_masters','freight_master_costs','freight_master_allocations'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON opportunities, supplier_contracts, supplier_policy, freight_masters, freight_master_costs TO lbt_app;
GRANT SELECT,INSERT,DELETE ON opportunity_lanes, opportunity_quotes TO lbt_app;
GRANT SELECT,INSERT ON opportunity_events, rate_tiers, freight_master_allocations TO lbt_app;
GRANT USAGE,SELECT ON SEQUENCE opportunity_events_id_seq TO lbt_app;
