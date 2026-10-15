-- A supplier invoice received through the e-invoicing provider can be forwarded into purchasing as a draft bill (once), or dismissed with a reason.
ALTER TABLE einvoice_inbound ADD COLUMN bill_id uuid, ADD COLUMN handled_by uuid REFERENCES users(id), ADD COLUMN handled_at timestamptz, ADD COLUMN dismiss_reason text;
ALTER TABLE einvoice_inbound ADD CONSTRAINT einvoice_inbound_status CHECK (status IN ('received','billed','dismissed'));
ALTER TABLE einvoice_inbound ADD CONSTRAINT einvoice_inbound_handled CHECK (
  (status = 'received' AND bill_id IS NULL AND handled_at IS NULL) OR (status = 'billed' AND bill_id IS NOT NULL AND handled_at IS NOT NULL) OR (status = 'dismissed' AND dismiss_reason IS NOT NULL AND handled_at IS NOT NULL));
ALTER TABLE einvoice_inbound ADD FOREIGN KEY (tenant_id, bill_id) REFERENCES vendor_bills(tenant_id, id);
CREATE UNIQUE INDEX einvoice_inbound_one_bill ON einvoice_inbound (bill_id) WHERE bill_id IS NOT NULL;
GRANT UPDATE (status, bill_id, handled_by, handled_at, dismiss_reason) ON einvoice_inbound TO lbt_app;
