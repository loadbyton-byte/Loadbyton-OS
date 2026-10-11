-- Account recovery is global identity data, like users and sessions.
-- The tenant application role must never read or write recovery credentials.
CREATE TABLE password_recoveries (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_recoveries_user ON password_recoveries(user_id);
REVOKE ALL ON password_recoveries FROM lbt_app;
