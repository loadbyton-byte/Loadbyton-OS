CREATE TABLE business_calendars (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),weekdays integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
 start_hour integer NOT NULL DEFAULT 9 CHECK(start_hour BETWEEN 0 AND 23),end_hour integer NOT NULL DEFAULT 18 CHECK(end_hour BETWEEN 1 AND 24),
 holidays text[] NOT NULL DEFAULT '{}',CHECK(end_hour>start_hour)
);
CREATE TABLE conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),party_id uuid NOT NULL,job_id uuid,
 subject text NOT NULL,source text NOT NULL,external_ref text NOT NULL,owner_id uuid REFERENCES users(id),accepted_at timestamptz,
 priority text NOT NULL CHECK(priority IN ('urgent','high','normal','low')),due_at timestamptz NOT NULL,
 email_consent boolean NOT NULL DEFAULT false,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,party_id) REFERENCES parties(tenant_id,id),FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,source,external_ref)
);
CREATE TABLE conversation_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),conversation_id uuid NOT NULL,
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')),body text NOT NULL,reference text NOT NULL,
 status text NOT NULL CHECK(status IN ('captured','draft','approved','sent','failed')),approved_by uuid REFERENCES users(id),
 sent_at timestamptz,external_id text,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id),UNIQUE(tenant_id,id),UNIQUE(tenant_id,conversation_id,reference)
);
CREATE FUNCTION message_body_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.conversation_id,NEW.direction,NEW.body,NEW.reference,NEW.created_by) IS DISTINCT FROM
 (OLD.tenant_id,OLD.conversation_id,OLD.direction,OLD.body,OLD.reference,OLD.created_by)
 THEN RAISE EXCEPTION 'message evidence is immutable'; END IF;RETURN NEW;END $$;
CREATE TRIGGER message_body_immutable BEFORE UPDATE ON conversation_messages FOR EACH ROW EXECUTE FUNCTION message_body_immutable();
CREATE TABLE migration_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),source_document_id uuid NOT NULL,
 purpose text NOT NULL,source_hash text NOT NULL,mapping jsonb NOT NULL,report jsonb NOT NULL,
 status text NOT NULL DEFAULT 'validated' CHECK(status IN ('validated','approved','applied','rolled_back')),
 approved_by uuid REFERENCES users(id),evidence text,created_ids uuid[] NOT NULL DEFAULT '{}',created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz,
 FOREIGN KEY(tenant_id,source_document_id) REFERENCES documents(tenant_id,id),UNIQUE(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['business_calendars','conversations','conversation_messages','migration_batches'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON business_calendars,conversations,conversation_messages,migration_batches TO lbt_app;
CREATE INDEX inbox_due ON conversations(tenant_id,status,due_at);
