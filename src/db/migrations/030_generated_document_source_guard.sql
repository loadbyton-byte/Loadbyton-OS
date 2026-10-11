CREATE FUNCTION generated_document_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM document_templates WHERE tenant_id=NEW.tenant_id AND id=NEW.template_id AND kind=NEW.kind)
 OR NOT EXISTS(SELECT 1 FROM documents WHERE tenant_id=NEW.tenant_id AND id=NEW.source_document_id AND job_id=NEW.job_id)
 THEN RAISE EXCEPTION 'generated draft template and evidence must match its kind and source job';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generated_document_source_guard BEFORE INSERT ON generated_documents FOR EACH ROW EXECUTE FUNCTION generated_document_source_guard();
