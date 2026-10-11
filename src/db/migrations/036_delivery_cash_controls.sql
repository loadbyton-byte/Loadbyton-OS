-- COD cash controls: unsettled-cash limits for offline riders, bank statement matching, and approved cash-shortage write-offs.
CREATE TABLE dlv_cash_policy (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), max_unsettled_minor bigint NOT NULL CHECK (max_unsettled_minor BETWEEN 0 AND 100000000),
 max_unsettled_hours int NOT NULL CHECK (max_unsettled_hours BETWEEN 1 AND 720), max_offline_hours int NOT NULL CHECK (max_offline_hours BETWEEN 1 AND 336),
 writeoff_owner_above_minor bigint NOT NULL DEFAULT 50000 CHECK (writeoff_owner_above_minor >= 0),
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dlv_bank_statements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), source_hash text NOT NULL, label text NOT NULL,
 line_count int NOT NULL CHECK (line_count > 0), imported_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, source_hash)
);
CREATE TABLE dlv_writeoffs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), no text NOT NULL,
 settlement_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor > 0), reason text NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
 proposed_by uuid NOT NULL REFERENCES users(id), proposed_at timestamptz NOT NULL DEFAULT now(),
 decided_by uuid REFERENCES users(id), decided_at timestamptz, decision_note text,
 FOREIGN KEY (tenant_id, settlement_id) REFERENCES dlv_settlements(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, no),
 CHECK ((status = 'proposed') = (decided_by IS NULL))
);
CREATE TABLE dlv_bank_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), statement_id uuid NOT NULL, line_no int NOT NULL,
 line_date date NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor <> 0), reference text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','ignored')),
 settlement_id uuid, remittance_id uuid, match_basis text CHECK (match_basis IN ('auto','manual')), category text CHECK (category IN ('refund','bank_fee','other')),
 note text, decided_by uuid REFERENCES users(id), decided_at timestamptz,
 FOREIGN KEY (tenant_id, statement_id) REFERENCES dlv_bank_statements(tenant_id, id),
 FOREIGN KEY (tenant_id, settlement_id) REFERENCES dlv_settlements(tenant_id, id), FOREIGN KEY (tenant_id, remittance_id) REFERENCES dlv_remittances(tenant_id, id),
 UNIQUE (tenant_id, id), UNIQUE (statement_id, line_no),
 CHECK ((status = 'matched') = (num_nonnulls(settlement_id, remittance_id) = 1)),
 CHECK (status <> 'ignored' OR category IS NOT NULL)
);
CREATE UNIQUE INDEX dlv_bank_lines_one_per_settlement ON dlv_bank_lines (tenant_id, settlement_id) WHERE settlement_id IS NOT NULL;
CREATE UNIQUE INDEX dlv_bank_lines_one_per_remittance ON dlv_bank_lines (tenant_id, remittance_id) WHERE remittance_id IS NOT NULL;
CREATE FUNCTION dlv_bank_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.tenant_id,NEW.statement_id,NEW.line_no,NEW.line_date,NEW.amount_minor,NEW.reference,NEW.description) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.statement_id,OLD.line_no,OLD.line_date,OLD.amount_minor,OLD.reference,OLD.description)
 THEN RAISE EXCEPTION 'imported bank statement lines are immutable; only their match state changes'; END IF; RETURN NEW; END $$;
CREATE TRIGGER dlv_bank_line_guard BEFORE UPDATE OR DELETE ON dlv_bank_lines FOR EACH ROW EXECUTE FUNCTION dlv_bank_line_guard();
CREATE FUNCTION dlv_writeoff_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.status <> 'proposed' OR (NEW.id,NEW.tenant_id,NEW.no,NEW.settlement_id,NEW.amount_minor,NEW.reason,NEW.proposed_by,NEW.proposed_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.no,OLD.settlement_id,OLD.amount_minor,OLD.reason,OLD.proposed_by,OLD.proposed_at)
 THEN RAISE EXCEPTION 'write-off proposals are immutable and decided once'; END IF; RETURN NEW; END $$;
CREATE TRIGGER dlv_writeoff_guard BEFORE UPDATE OR DELETE ON dlv_writeoffs FOR EACH ROW EXECUTE FUNCTION dlv_writeoff_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['dlv_cash_policy','dlv_bank_statements','dlv_writeoffs','dlv_bank_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON dlv_cash_policy, dlv_bank_lines, dlv_writeoffs TO lbt_app;
GRANT SELECT,INSERT ON dlv_bank_statements TO lbt_app;
