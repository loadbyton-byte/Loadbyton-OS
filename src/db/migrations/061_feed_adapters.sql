-- Statement feeds for providers whose API is not a single JSON list: OAuth2 client-credentials sign-in, paged answers (cursor, page number or Link header) and CSV answers.
ALTER TABLE feed_connections DROP CONSTRAINT IF EXISTS feed_connections_auth_scheme_check;
ALTER TABLE feed_connections ADD CONSTRAINT feed_connections_auth_scheme_check CHECK (auth_scheme IN ('bearer','header','oauth2_client'));
ALTER TABLE feed_connections
 ADD COLUMN token_url text, ADD COLUMN token_scope text,
 ADD COLUMN response_format text NOT NULL DEFAULT 'json' CHECK (response_format IN ('json','csv')),
 ADD COLUMN page_mode text NOT NULL DEFAULT 'none' CHECK (page_mode IN ('none','cursor','page','link')),
 ADD COLUMN page_param text, ADD COLUMN next_path text, ADD COLUMN max_pages int NOT NULL DEFAULT 10 CHECK (max_pages BETWEEN 1 AND 50);
