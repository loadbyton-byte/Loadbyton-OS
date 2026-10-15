-- A provider account (taxpayer / company reference) belongs to one workspace, so a webhook can only ever mean one tenant.
CREATE UNIQUE INDEX einvoice_service_provider_account ON einvoice_service (provider, taxpayer_ref) WHERE provider IS NOT NULL AND taxpayer_ref IS NOT NULL;
-- When the status poller last asked the provider about a document still awaiting its decision.
ALTER TABLE einvoice_documents ADD COLUMN polled_at timestamptz;
