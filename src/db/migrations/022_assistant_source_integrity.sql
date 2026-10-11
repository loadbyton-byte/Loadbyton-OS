CREATE FUNCTION assistant_source_integrity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status<>'generating' OR
 NOT EXISTS(SELECT 1 FROM memberships WHERE tenant_id=NEW.tenant_id AND user_id=NEW.created_by AND active) OR
 (NEW.resource='enquiry' AND NOT EXISTS(SELECT 1 FROM enquiries WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id)) OR
 (NEW.resource='job' AND NOT EXISTS(SELECT 1 FROM jobs WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id))
 THEN RAISE EXCEPTION 'assistant source and author must belong to the company; insert only a pending draft'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER assistant_source_guard BEFORE INSERT ON assistant_drafts FOR EACH ROW EXECUTE FUNCTION assistant_source_integrity();
