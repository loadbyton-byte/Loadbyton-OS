-- Order pulls for real marketplace APIs: static query parameters, a first-pull lookback window, since-formats, a per-order detail call, a second access-token step, and refresh-token (LWA-style) sign-in.
ALTER TABLE order_pulls DROP CONSTRAINT IF EXISTS order_pulls_auth_scheme_check;
ALTER TABLE order_pulls ADD CONSTRAINT order_pulls_auth_scheme_check CHECK (auth_scheme IN ('bearer','header','oauth2_client','oauth2_refresh'));
ALTER TABLE order_pulls
 ADD COLUMN profile text, ADD COLUMN static_params jsonb NOT NULL DEFAULT '{}', ADD COLUMN since_format text NOT NULL DEFAULT 'iso' CHECK (since_format IN ('iso','date','sql')),
 ADD COLUMN lookback_days int CHECK (lookback_days IS NULL OR lookback_days BETWEEN 1 AND 90), ADD COLUMN cursor_only boolean NOT NULL DEFAULT false,
 ADD COLUMN detail_url text, ADD COLUMN token_header text, ADD COLUMN exchange_url text, ADD COLUMN exchange_body text, ADD COLUMN exchange_token_path text;
