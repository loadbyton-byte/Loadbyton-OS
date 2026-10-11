-- Also upgrades development databases that exercised an earlier draft of migration 007.
ALTER TABLE provision_jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE provision_jobs ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS company_mfa_ok boolean NOT NULL DEFAULT false;
