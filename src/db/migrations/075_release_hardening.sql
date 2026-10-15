-- Freeze invoice identity at issuance. Existing invoices cannot recover earlier master data:
-- their baseline is explicitly marked as captured during migration.
ALTER TABLE invoices ADD COLUMN seller_snapshot jsonb;
ALTER TABLE invoices ADD COLUMN buyer_snapshot jsonb;
ALTER TABLE invoices ADD COLUMN identity_snapshot_source text NOT NULL DEFAULT 'issuance';
UPDATE invoices i SET seller_snapshot=to_jsonb(e), buyer_snapshot=to_jsonb(p) - ARRAY['email','phone','notes']::text[], identity_snapshot_source='legacy_migration'
 FROM entities e, parties p WHERE e.id=i.entity_id AND p.id=i.party_id AND e.tenant_id=i.tenant_id AND p.tenant_id=i.tenant_id;
ALTER TABLE invoices ALTER COLUMN seller_snapshot SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN buyer_snapshot SET NOT NULL;
CREATE FUNCTION invoice_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   SELECT to_jsonb(e) INTO NEW.seller_snapshot FROM entities e WHERE e.id=NEW.entity_id AND e.tenant_id=NEW.tenant_id FOR SHARE;
   SELECT to_jsonb(p) - ARRAY['email','phone','notes']::text[] INTO NEW.buyer_snapshot FROM parties p WHERE p.id=NEW.party_id AND p.tenant_id=NEW.tenant_id FOR SHARE;
   NEW.identity_snapshot_source := 'issuance';
 ELSIF (NEW.seller_snapshot,NEW.buyer_snapshot,NEW.identity_snapshot_source,NEW.entity_id,NEW.party_id)
   IS DISTINCT FROM (OLD.seller_snapshot,OLD.buyer_snapshot,OLD.identity_snapshot_source,OLD.entity_id,OLD.party_id) THEN
   RAISE EXCEPTION 'issued invoice identity is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_identity_frozen BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_identity_guard();
-- Every user, including owners, needs an independent journal approver.
ALTER TABLE gl_manual_entries ADD CONSTRAINT gl_independent_decision CHECK (decided_by IS NULL OR decided_by <> proposed_by) NOT VALID;
