-- Background workers may run on any number of web instances: each named job runs on whichever instance currently holds its short lease.
CREATE TABLE worker_leases (name text PRIMARY KEY, holder text NOT NULL, expires_at timestamptz NOT NULL, renewed_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON worker_leases FROM lbt_app;
