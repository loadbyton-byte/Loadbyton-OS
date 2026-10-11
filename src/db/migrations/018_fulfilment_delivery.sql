ALTER TABLE fulfil_shipments ADD COLUMN delivery_parcel_id uuid;
ALTER TABLE fulfil_shipments ADD CONSTRAINT fulfilment_parcel_tenant_fk FOREIGN KEY(tenant_id,delivery_parcel_id) REFERENCES delivery_parcels(tenant_id,id);
CREATE UNIQUE INDEX one_shipment_per_parcel ON fulfil_shipments(tenant_id,delivery_parcel_id) WHERE delivery_parcel_id IS NOT NULL;
CREATE FUNCTION fulfilment_shipment_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'shipment source and delivery lineage are immutable'; END IF;
 IF (NEW.tenant_id,NEW.order_id,NEW.carrier,NEW.tracking_no,NEW.cartons,NEW.weight_g,NEW.shipped_at,NEW.created_by) IS DISTINCT FROM
 (OLD.tenant_id,OLD.order_id,OLD.carrier,OLD.tracking_no,OLD.cartons,OLD.weight_g,OLD.shipped_at,OLD.created_by)
 OR (OLD.delivery_parcel_id IS NOT NULL AND NEW.delivery_parcel_id IS DISTINCT FROM OLD.delivery_parcel_id)
 THEN RAISE EXCEPTION 'shipment source and delivery lineage are immutable'; END IF;RETURN NEW;END $$;
CREATE TRIGGER shipment_source_immutable BEFORE UPDATE OR DELETE ON fulfil_shipments FOR EACH ROW EXECUTE FUNCTION fulfilment_shipment_source_immutable();
