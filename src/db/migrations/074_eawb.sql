-- Air waybill stock and electronic air waybill (FWB) messages. A message is built and kept here; sending it to an airline or handler needs that party's own agreement and channel,
-- so a person hands the file over and records that they did.
CREATE TABLE awb_stock (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), prefix text NOT NULL CHECK (prefix ~ '^[0-9]{3}$'), airline text NOT NULL,
 first_serial int NOT NULL CHECK (first_serial BETWEEN 0 AND 9999999), last_serial int NOT NULL CHECK (last_serial BETWEEN 0 AND 9999999), next_serial int NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (last_serial >= first_serial), CHECK (next_serial BETWEEN first_serial AND last_serial + 1), UNIQUE (tenant_id, id), UNIQUE (tenant_id, prefix, first_serial)
);
CREATE TABLE eawb_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), job_id uuid NOT NULL, awb_no text NOT NULL, body text NOT NULL, body_sha256 text NOT NULL,
 status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','handed_over','void')), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 handed_over_by uuid REFERENCES users(id), handed_over_at timestamptz, handed_over_note text, void_reason text,
 FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id), UNIQUE (tenant_id, id),
 CHECK (status <> 'handed_over' OR (handed_over_by IS NOT NULL AND handed_over_at IS NOT NULL)), CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
CREATE UNIQUE INDEX eawb_one_live ON eawb_messages (tenant_id, awb_no) WHERE status <> 'void';
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['awb_stock','eawb_messages'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
END LOOP; END $$;
GRANT SELECT, INSERT, UPDATE ON awb_stock, eawb_messages TO lbt_app;
