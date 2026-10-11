-- Native general ledger. A double-entry journal projected from the existing sub-ledgers (invoices, receipts, credit notes, supplier bills and payments) plus
-- manual adjusting entries that one person proposes and another approves. Journals and their lines are immutable; a correction is a reversing journal.
-- The ledger starts on an explicit date; anything earlier enters as an opening-balance manual entry. Amounts are in the entity's base currency.
CREATE TABLE gl_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), start_date date NOT NULL, enabled_by uuid NOT NULL REFERENCES users(id), enabled_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gl_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), code text NOT NULL CHECK (code ~ '^[0-9A-Za-z.-]{1,12}$'), name text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('asset','liability','equity','income','expense')),
 role text CHECK (role IN ('bank','ar','input_vat','ap','output_vat','revenue','cost','fx')), active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, code), UNIQUE (tenant_id, role)
);
CREATE TABLE gl_journals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), no bigint NOT NULL, posted_on date NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
 memo text NOT NULL, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id), UNIQUE (tenant_id, no), UNIQUE (tenant_id, source_type, source_id)
);
CREATE TABLE gl_lines (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), journal_id uuid NOT NULL, account_id uuid NOT NULL,
 debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0), credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0), memo text,
 CHECK ((debit_minor > 0) <> (credit_minor > 0)),
 FOREIGN KEY (tenant_id, journal_id) REFERENCES gl_journals(tenant_id, id), FOREIGN KEY (tenant_id, account_id) REFERENCES gl_accounts(tenant_id, id)
);
CREATE INDEX gl_lines_account ON gl_lines (tenant_id, account_id);
CREATE INDEX gl_lines_journal ON gl_lines (journal_id);
CREATE FUNCTION gl_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; n int;
BEGIN
 SELECT coalesce(sum(debit_minor) - sum(credit_minor), 0), count(*) INTO d, n FROM gl_lines WHERE journal_id = NEW.journal_id;
 IF d <> 0 OR n < 2 THEN RAISE EXCEPTION 'a journal must balance and have at least two lines'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gl_balanced AFTER INSERT ON gl_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gl_balance_check();
CREATE TRIGGER gl_journals_immutable BEFORE UPDATE OR DELETE ON gl_journals FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER gl_lines_immutable BEFORE UPDATE OR DELETE ON gl_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TABLE gl_manual_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), entry_date date NOT NULL, memo text NOT NULL, lines jsonb NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')), proposed_by uuid NOT NULL REFERENCES users(id), decided_by uuid REFERENCES users(id),
 decided_at timestamptz, journal_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id),
 CHECK ((status = 'proposed') = (decided_by IS NULL)), CHECK ((status = 'approved') = (journal_id IS NOT NULL))
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['gl_settings','gl_accounts','gl_journals','gl_lines','gl_manual_entries'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT,INSERT ON gl_settings, gl_journals, gl_lines TO lbt_app;
GRANT SELECT,INSERT,UPDATE ON gl_accounts, gl_manual_entries TO lbt_app;
GRANT USAGE,SELECT ON SEQUENCE gl_lines_id_seq TO lbt_app;
