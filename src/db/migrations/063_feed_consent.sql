-- Open-banking style consent for statement feeds: OAuth2 authorization-code flow with PKCE. The account holder approves at the bank; the workspace stores only
-- sealed tokens, a consent expiry and the time consent was given. Withdrawing consent erases the tokens.
ALTER TABLE feed_connections DROP CONSTRAINT IF EXISTS feed_connections_auth_scheme_check;
ALTER TABLE feed_connections ADD CONSTRAINT feed_connections_auth_scheme_check CHECK (auth_scheme IN ('bearer','header','oauth2_client','oauth2_authcode'));
ALTER TABLE feed_connections
 ADD COLUMN authorize_url text, ADD COLUMN consent_state_hash text, ADD COLUMN consent_verifier_sealed text, ADD COLUMN consent_started_at timestamptz,
 ADD COLUMN token_sealed text, ADD COLUMN consented_at timestamptz, ADD COLUMN consent_expires_at timestamptz;
