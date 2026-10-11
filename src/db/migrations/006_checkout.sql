-- Real payment providers: the provider-hosted checkout address (so a pending order can be resumed) and a lookup by the provider's
-- own payment handle (so a later refund finds its order even when the provider omits our metadata).
ALTER TABLE orders ADD COLUMN checkout_url text;
CREATE INDEX payment_events_provider_ref ON payment_events ((payload->>'provider_ref')) WHERE payload->>'provider_ref' IS NOT NULL;
