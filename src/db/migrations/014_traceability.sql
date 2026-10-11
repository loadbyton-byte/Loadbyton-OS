ALTER TABLE wh_skus ADD COLUMN rotation text NOT NULL DEFAULT 'fifo' CHECK(rotation IN ('fifo','fefo'));
ALTER TABLE wh_skus ADD COLUMN tracking text NOT NULL DEFAULT 'none' CHECK(tracking IN ('none','lot','serial'));
CREATE TABLE wh_lots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),owner_id uuid NOT NULL,sku_id uuid NOT NULL,
 lot text NOT NULL CHECK(length(lot)>0),expires_at date,serial_ref text,document_id uuid NOT NULL,
 hold boolean NOT NULL DEFAULT false,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,owner_id,sku_id) REFERENCES wh_skus(tenant_id,owner_id,id),FOREIGN KEY(tenant_id,document_id) REFERENCES documents(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,owner_id,sku_id,lot),UNIQUE(tenant_id,owner_id,serial_ref)
);
CREATE FUNCTION lot_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.owner_id,NEW.sku_id,NEW.lot,NEW.expires_at,NEW.serial_ref,NEW.document_id,NEW.created_by) IS DISTINCT FROM
 (OLD.tenant_id,OLD.owner_id,OLD.sku_id,OLD.lot,OLD.expires_at,OLD.serial_ref,OLD.document_id,OLD.created_by)
 THEN RAISE EXCEPTION 'lot source identity is immutable'; END IF;RETURN NEW;END $$;
CREATE TRIGGER lot_identity_immutable BEFORE UPDATE ON wh_lots FOR EACH ROW EXECUTE FUNCTION lot_identity_immutable();
ALTER TABLE wh_lots ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wh_lots USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON wh_lots TO lbt_app;
