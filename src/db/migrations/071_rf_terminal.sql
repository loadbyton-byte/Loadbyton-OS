-- PINs for handheld RF terminals. A PIN is only a second, short secret for a user who already belongs to the company; it is stored hashed and the account locks after repeated wrong attempts.
CREATE TABLE rf_pins (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), pin_hash text NOT NULL,
 failed int NOT NULL DEFAULT 0, locked_until timestamptz, set_by uuid NOT NULL REFERENCES users(id), set_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE rf_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rf_pins USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON rf_pins TO lbt_app;
