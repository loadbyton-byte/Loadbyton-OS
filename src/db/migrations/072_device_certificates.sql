-- Certificates for field devices (calibration, qualification, type approval). The certificate itself is issued by an accredited laboratory or the maker; this register records it, has a second person
-- approve it, and — for a device switched to "require certificate" — refuses its readings while no approved, in-date certificate covers the time of the reading.
ALTER TABLE specialist_devices ADD COLUMN require_certificate boolean NOT NULL DEFAULT false;
CREATE TABLE device_certificates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), device_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('calibration','qualification','type_approval')), certificate_no text NOT NULL, issuer text NOT NULL, accreditation_ref text,
 issued_on date NOT NULL, valid_until date NOT NULL, evidence_ref text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','revoked')),
 recorded_by uuid NOT NULL REFERENCES users(id), recorded_at timestamptz NOT NULL DEFAULT now(), approved_by uuid REFERENCES users(id), approved_at timestamptz, revoked_reason text,
 FOREIGN KEY (tenant_id, device_id) REFERENCES specialist_devices(tenant_id, id), UNIQUE (tenant_id, id), UNIQUE (device_id, issuer, certificate_no),
 CHECK (valid_until > issued_on), CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_by <> recorded_by AND approved_at IS NOT NULL)),
 CHECK (status <> 'revoked' OR revoked_reason IS NOT NULL)
);
ALTER TABLE device_certificates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_certificates USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT, UPDATE ON device_certificates TO lbt_app;
