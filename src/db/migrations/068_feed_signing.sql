-- Bank-grade statement feeds: mutual TLS (client certificate + key, optional pinned server CA), request message signing (detached JWS or Cavage HTTP Signature with Digest) and
-- private_key_jwt client authentication. Keys are sealed at rest and never shown again.
ALTER TABLE feed_connections
 ADD COLUMN tls_cert_sealed text, ADD COLUMN tls_key_sealed text, ADD COLUMN tls_ca text,
 ADD COLUMN sign_mode text NOT NULL DEFAULT 'none' CHECK (sign_mode IN ('none','jws','http_signature')),
 ADD COLUMN sign_alg text CHECK (sign_alg IN ('PS256','RS256','ES256')), ADD COLUMN sign_kid text, ADD COLUMN sign_key_sealed text, ADD COLUMN sign_header text NOT NULL DEFAULT 'x-jws-signature',
 ADD COLUMN client_auth text NOT NULL DEFAULT 'secret' CHECK (client_auth IN ('secret','private_key_jwt')),
 ADD CONSTRAINT feed_sign_complete CHECK ((sign_mode = 'none') OR (sign_alg IS NOT NULL AND sign_kid IS NOT NULL AND sign_key_sealed IS NOT NULL)),
 ADD CONSTRAINT feed_pkjwt_key CHECK (client_auth = 'secret' OR sign_key_sealed IS NOT NULL),
 ADD CONSTRAINT feed_tls_pair CHECK ((tls_cert_sealed IS NULL) = (tls_key_sealed IS NULL));
